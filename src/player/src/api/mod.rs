//! The command API (spec §4.2 "Command API", §9): JSON Lines over a unix socket.
//!
//! - [`proto`] — request/reply/event shapes, line limits, error constructors.
//! - [`server`] — socket binding (single instance, `0700`/`0600`), per-client
//!   non-blocking I/O with bounded queues, the event tap behind `subscribe`.
//! - [`handlers`] — the verbs.
//!
//! The loop that drives all of it is `crate::runtime`; the shell client is `crate::ctl`.
//! Reference: `.claude/rules/player-core.md` § Command API.

pub mod handlers;
pub mod proto;
pub mod server;
