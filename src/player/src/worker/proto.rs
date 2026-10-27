//! The scene worker's wire protocol (Phase 2 Task 3; `.claude/rules/player-core.md` § Scene
//! worker): one JSON object per `SOCK_SEQPACKET` datagram (≤ [`MAX_MSG`] = 64 KiB), file
//! descriptors (dmabuf planes, sync_file fences) riding `SCM_RIGHTS` on the same datagram.
//! Both ends use these types — the compositor (`worker::WorkerHost`) and `lp-scene-worker`.
//!
//! JSON, not a fixed C struct like the spike's `common.h`: the messages are small and rare
//! enough (one `Frame` per rendered frame, ~100 bytes) that serde costs nothing measurable,
//! and an unknown or malformed message is a clean `Err` the receiver skips, never UB.

use std::cell::RefCell;
use std::io;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change; `Hello.protocol` must equal it.
pub const PROTOCOL: u32 = 1;
/// Largest datagram either side sends or accepts.
pub const MAX_MSG: usize = 64 * 1024;
/// Most fds one datagram may carry (a 4-plane buffer + a fence, with room to spare).
pub const MAX_FDS: usize = 8;

/// Compositor → worker.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum ToWorker {
    /// Load the scene at `path` (the item folder). `position` = scene time to start at;
    /// `max_size` = the largest output showing it (the ring is sized by `scene::cover_size`);
    /// `synthetic` = render `lp-synthetic.json` instead of LWE (tests only — the worker also
    /// requires `LP_PLAYER_ALLOW_SYNTHETIC_SCENES=1` in its environment).
    Start {
        path: String,
        assets_dir: Option<String>,
        steam_dir: Option<String>,
        position: f64,
        paused: bool,
        audio: AudioRoute,
        max_size: [u32; 2],
        synthetic: bool,
    },
    /// Render one frame at scene time `t` (seconds). `input` = 1024 u8 visualiser samples.
    /// Answered by a `Frame` carrying `seq` (the heartbeat: an unanswered one is a hang).
    Tick {
        seq: u64,
        t: f64,
        input: Option<Vec<u8>>,
    },
    /// The compositor stopped sampling `slot`; optional release fence fd attached.
    Release {
        slot: u8,
    },
    Gain {
        db: f64,
    },
    Paused {
        paused: bool,
    },
    NoAudio {
        on: bool,
    },
    Route {
        audio: AudioRoute,
    },
    Pointer {
        x: f64,
        y: f64,
        buttons: u32,
    },
    Resize {
        max_size: [u32; 2],
    },
    /// Heartbeat while no ticks are due; answered by `Pong` with the same `seq`.
    Ping {
        seq: u64,
    },
    Quit,
}

/// Worker → compositor.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum FromWorker {
    /// First message. `features`: `stub`, `synthetic`, `lwe`. `sync`: `fence` (acquire fence
    /// fd on every `Frame`) | `fdpoll` (the worker waited on its own fence; no fd) | `none`
    /// (stub).
    Hello {
        protocol: u32,
        pid: u32,
        features: Vec<String>,
        sync: String,
    },
    /// One ring slot, exported once; one fd per plane attached. `slot` is an id unique for
    /// the worker's lifetime (a re-exported ring gets new ids), not an index.
    Buffer {
        slot: u8,
        w: u32,
        h: u32,
        fourcc: u32,
        modifier: u64,
        planes: Vec<Plane>,
    },
    /// `slot` holds the frame of tick `seq` at scene time `t`; acquire fence fd attached
    /// (none in `fdpoll` mode — the frame is already complete).
    Frame {
        slot: u8,
        seq: u64,
        t: f64,
        gpu_ms: Option<f32>,
    },
    Ready {
        native: [u32; 2],
        has_audio: bool,
        wants_audio_input: bool,
    },
    HasAudio {
        on: bool,
    },
    AudioFlowing,
    Envelope {
        t0_ms: f64,
        dbfs_1ms: Vec<f32>,
    },
    Pong {
        seq: u64,
    },
    /// `fatal` = the scene can't play (load/build failed, no GPU): the worker stays up,
    /// idle, until `Quit` — the caller stops it, so a deterministic failure is never a crash
    /// loop and never a crash record.
    Error {
        reason: String,
        fatal: bool,
    },
    ContextLost,
    Log {
        level: String,
        line: String,
    },
}

/// Where a scene's audio goes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioRoute {
    Null,
    Default,
    Device(String),
}

/// One dmabuf plane's layout (its fd travels alongside).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plane {
    pub offset: u32,
    pub stride: u32,
}

/// Send `m` as one datagram with `fds` attached (`SCM_RIGHTS`; the kernel dups them, the
/// caller keeps its own). `InvalidInput` if it serialises past [`MAX_MSG`] or carries more
/// than [`MAX_FDS`]; `WouldBlock` on a full non-blocking socket; never `SIGPIPE`.
pub fn send<M: Serialize>(fd: BorrowedFd, m: &M, fds: &[BorrowedFd]) -> io::Result<()> {
    let bytes =
        serde_json::to_vec(m).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
    if bytes.len() > MAX_MSG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("message of {} bytes exceeds {MAX_MSG}", bytes.len()),
        ));
    }
    if fds.len() > MAX_FDS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} fds exceed {MAX_FDS}", fds.len()),
        ));
    }
    let mut iov = libc::iovec {
        iov_base: bytes.as_ptr() as *mut _,
        iov_len: bytes.len(),
    };
    let raw: Vec<i32> = fds.iter().map(|f| f.as_raw_fd()).collect();
    let space = unsafe { libc::CMSG_SPACE(std::mem::size_of_val(raw.as_slice()) as u32) } as usize;
    let mut cbuf = vec![0u8; if raw.is_empty() { 0 } else { space }];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    if !raw.is_empty() {
        msg.msg_control = cbuf.as_mut_ptr().cast();
        msg.msg_controllen = space;
        unsafe {
            let c = libc::CMSG_FIRSTHDR(&msg);
            (*c).cmsg_level = libc::SOL_SOCKET;
            (*c).cmsg_type = libc::SCM_RIGHTS;
            (*c).cmsg_len = libc::CMSG_LEN(std::mem::size_of_val(raw.as_slice()) as u32) as usize;
            std::ptr::copy_nonoverlapping(
                raw.as_ptr(),
                libc::CMSG_DATA(c).cast::<i32>(),
                raw.len(),
            );
        }
    }
    loop {
        let n = unsafe { libc::sendmsg(fd.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) };
        if n >= 0 {
            return Ok(());
        }
        let e = io::Error::last_os_error();
        if e.kind() != io::ErrorKind::Interrupted {
            return Err(e);
        }
    }
}

thread_local! {
    static RECV_BUF: RefCell<Vec<u8>> = RefCell::new(vec![0u8; MAX_MSG + 1]);
}

/// Receive one datagram without blocking: `Ok(None)` = nothing queued;
/// `Err(UnexpectedEof)` = the peer is gone; `Err(InvalidData)` = oversized, truncated
/// control data or not a valid message (that datagram is consumed and its fds closed — the
/// next one parses normally).
pub fn recv<M: DeserializeOwned>(fd: BorrowedFd) -> io::Result<Option<(M, Vec<OwnedFd>)>> {
    RECV_BUF.with(|b| {
        let mut buf = b.borrow_mut();
        let mut iov = libc::iovec {
            iov_base: buf.as_mut_ptr().cast(),
            iov_len: buf.len(),
        };
        let space =
            unsafe { libc::CMSG_SPACE((MAX_FDS * std::mem::size_of::<i32>()) as u32) } as usize;
        let mut cbuf = vec![0u8; space];
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = cbuf.as_mut_ptr().cast();
        msg.msg_controllen = space;
        let n = loop {
            let n = unsafe {
                libc::recvmsg(
                    fd.as_raw_fd(),
                    &mut msg,
                    libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC,
                )
            };
            if n >= 0 {
                break n as usize;
            }
            let e = io::Error::last_os_error();
            match e.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => return Ok(None),
                _ => return Err(e),
            }
        };
        // Take ownership of every fd first, so an error below still closes them.
        let mut fds = Vec::new();
        unsafe {
            let mut c = libc::CMSG_FIRSTHDR(&msg);
            while !c.is_null() {
                if (*c).cmsg_level == libc::SOL_SOCKET && (*c).cmsg_type == libc::SCM_RIGHTS {
                    let data = libc::CMSG_DATA(c).cast::<i32>();
                    let len = (*c).cmsg_len - libc::CMSG_LEN(0) as usize;
                    for i in 0..len / std::mem::size_of::<i32>() {
                        fds.push(OwnedFd::from_raw_fd(data.add(i).read_unaligned()));
                    }
                }
                c = libc::CMSG_NXTHDR(&msg, c);
            }
        }
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "worker socket: peer closed",
            ));
        }
        if n > MAX_MSG || msg.msg_flags & libc::MSG_TRUNC != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("datagram over {MAX_MSG} bytes"),
            ));
        }
        if msg.msg_flags & libc::MSG_CTRUNC != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("more than {MAX_FDS} fds on one datagram"),
            ));
        }
        let m = serde_json::from_slice::<M>(&buf[..n]).map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "bad message ({e}): {}",
                    String::from_utf8_lossy(&buf[..n.min(120)])
                ),
            )
        })?;
        Ok(Some((m, fds)))
    })
}
