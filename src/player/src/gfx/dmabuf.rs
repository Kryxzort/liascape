//! GPU frames between processes (Phase 2 Task 4; `docs/player/spikes/dmabuf.md` §2, §9):
//! a texture exported once as a dmabuf (`EGL_MESA_image_dma_buf_export`), imported once on the
//! other side (`EGL_EXT_image_dma_buf_import_modifiers` + `glEGLImageTargetTexture2DOES`),
//! and `sync_file` fences both ways (`EGL_ANDROID_native_fence_sync`). Methods on [`Gfx`]
//! (in their own file rather than `egl.rs`, which other Phase 2 work also extends). Every
//! entry point the extensions add is fetched by name once per process.

use std::ffi::c_void;
use std::os::fd::{FromRawFd, IntoRawFd, OwnedFd};
use std::sync::OnceLock;

use glow::HasContext;
use khronos_egl as egl;
use serde::{Deserialize, Serialize};

use super::egl::{Gfx, GlKeepAlive};
use super::gl::Tex;

/// `DRM_FORMAT_ABGR8888` (`AB24`) — what a `GL_RGBA8` texture exports as.
pub const DRM_FORMAT_ABGR8888: u32 = u32::from_le_bytes(*b"AB24");

const GL_TEXTURE_2D_TARGET: egl::Enum = 0x30B1; // EGL_GL_TEXTURE_2D
const GL_TEXTURE_LEVEL: egl::Attrib = 0x30BC;
const LINUX_DMA_BUF: egl::Enum = 0x3270;
const LINUX_DRM_FOURCC: egl::Attrib = 0x3271;
const SYNC_NATIVE_FENCE: egl::Enum = 0x3144;
const SYNC_NATIVE_FENCE_FD: egl::Attrib = 0x3145;
const NO_NATIVE_FENCE_FD: egl::Attrib = -1isize as egl::Attrib;
/// Per plane: FD, OFFSET, PITCH, MODIFIER_LO, MODIFIER_HI.
const PLANE_ATTRS: [[egl::Attrib; 5]; 4] = [
    [0x3272, 0x3273, 0x3274, 0x3443, 0x3444],
    [0x3275, 0x3276, 0x3277, 0x3445, 0x3446],
    [0x3278, 0x3279, 0x327A, 0x3447, 0x3448],
    [0x3440, 0x3441, 0x3442, 0x3449, 0x344A],
];

/// One dmabuf plane's layout (its fd travels separately).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plane {
    pub offset: u32,
    pub stride: u32,
}

/// What an importer needs besides the fds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DmabufDesc {
    pub w: u32,
    pub h: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub planes: Vec<Plane>,
}

/// An `EGLImage`, destroyed on drop (no GL context needed for that).
pub struct EglImage {
    display: egl::Display,
    image: egl::Image,
}

impl EglImage {
    pub fn as_ptr(&self) -> *mut c_void {
        self.image.as_ptr()
    }
}

impl Drop for EglImage {
    fn drop(&mut self) {
        let _ = egl::Instance::new(egl::Static).destroy_image(self.display, self.image);
    }
}

/// A texture exported as a dmabuf: its layout, one fd per plane, and the `EGLImage` it was
/// exported through (kept for the texture's life, like the spike's producer).
pub struct Exported {
    pub desc: DmabufDesc,
    pub fds: Vec<OwnedFd>,
    pub image: EglImage,
}

/// A dmabuf imported as a sampleable `GL_TEXTURE_2D`. Owns the texture and the `EGLImage`;
/// the memory stays valid after the exporter dies (spike §6). Dropped on its own context.
pub struct ImportedTex {
    tex: Tex,
    image: Option<EglImage>,
    keep: GlKeepAlive,
}

impl ImportedTex {
    pub fn tex(&self) -> &Tex {
        &self.tex
    }
}

impl Drop for ImportedTex {
    fn drop(&mut self) {
        let guard = self.keep.make_current();
        if guard.is_current() {
            self.keep.delete_texture(&self.tex);
        }
        drop(guard);
        self.image.take();
    }
}

/// An EGL extension function, looked up once per process.
fn proc(cell: &'static OnceLock<usize>, gfx: &Gfx, name: &str) -> Option<usize> {
    let p = *cell.get_or_init(|| {
        gfx.egl_parts()
            .0
            .get_proc_address(name)
            .map_or(0, |f| f as usize)
    });
    (p != 0).then_some(p)
}

impl Gfx {
    /// `EGL_ANDROID_native_fence_sync` on this display (fences as `sync_file` fds).
    pub fn has_native_fences(&self) -> bool {
        self.has_display_ext("EGL_ANDROID_native_fence_sync")
    }

    /// Export `tex` (this context's) as a dmabuf, once: `eglCreateImage(EGL_GL_TEXTURE_2D)`
    /// → `eglExportDMABUFImageQueryMESA` + `eglExportDMABUFImageMESA`. NVIDIA may hand back
    /// the same fd for every plane — each plane gets its own fd here either way.
    pub fn export_dmabuf(&self, tex: &Tex) -> Result<Exported, String> {
        static QUERY: OnceLock<usize> = OnceLock::new();
        static EXPORT: OnceLock<usize> = OnceLock::new();
        type QueryFn = unsafe extern "system" fn(
            *mut c_void,
            *mut c_void,
            *mut i32,
            *mut i32,
            *mut u64,
        ) -> u32;
        type ExportFn = unsafe extern "system" fn(
            *mut c_void,
            *mut c_void,
            *mut i32,
            *mut i32,
            *mut i32,
        ) -> u32;
        let (Some(q), Some(x)) = (
            proc(&QUERY, self, "eglExportDMABUFImageQueryMESA"),
            proc(&EXPORT, self, "eglExportDMABUFImageMESA"),
        ) else {
            return Err("EGL_MESA_image_dma_buf_export missing on this display".into());
        };
        let (egl, display, context) = self.egl_parts();
        let image = egl
            .create_image(
                display,
                context,
                GL_TEXTURE_2D_TARGET,
                unsafe { egl::ClientBuffer::from_ptr(tex.id.0.get() as usize as *mut c_void) },
                &[GL_TEXTURE_LEVEL, 0, egl::ATTRIB_NONE],
            )
            .map_err(|e| format!("eglCreateImage(EGL_GL_TEXTURE_2D): {e}"))?;
        let image = EglImage { display, image };
        let (mut fourcc, mut nplanes) = (0i32, 0i32);
        let mut mods = [0u64; 4];
        let ok = unsafe {
            std::mem::transmute::<usize, QueryFn>(q)(
                display.as_ptr(),
                image.as_ptr(),
                &mut fourcc,
                &mut nplanes,
                mods.as_mut_ptr(),
            )
        };
        if ok == 0 || !(1..=4).contains(&nplanes) {
            return Err(format!(
                "eglExportDMABUFImageQueryMESA failed ({nplanes} planes)"
            ));
        }
        let (mut fds, mut strides, mut offsets) = ([-1i32; 4], [0i32; 4], [0i32; 4]);
        let ok = unsafe {
            std::mem::transmute::<usize, ExportFn>(x)(
                display.as_ptr(),
                image.as_ptr(),
                fds.as_mut_ptr(),
                strides.as_mut_ptr(),
                offsets.as_mut_ptr(),
            )
        };
        // Own every distinct fd returned, even on failure.
        let mut owned: Vec<(i32, OwnedFd)> = Vec::new();
        for &fd in fds.iter().take(nplanes as usize) {
            if fd >= 0 && !owned.iter().any(|(r, _)| *r == fd) {
                owned.push((fd, unsafe { OwnedFd::from_raw_fd(fd) }));
            }
        }
        if ok == 0 || owned.is_empty() {
            return Err("eglExportDMABUFImageMESA failed".into());
        }
        let mut plane_fds = Vec::new();
        for &fd in fds.iter().take(nplanes as usize) {
            let src = owned
                .iter()
                .find(|(r, _)| *r == fd)
                .map_or(&owned[0].1, |(_, o)| o);
            plane_fds.push(src.try_clone().map_err(|e| format!("dup dmabuf fd: {e}"))?);
        }
        Ok(Exported {
            desc: DmabufDesc {
                w: tex.w,
                h: tex.h,
                fourcc: fourcc as u32,
                modifier: mods[0],
                planes: (0..nplanes as usize)
                    .map(|i| Plane {
                        offset: offsets[i] as u32,
                        stride: strides[i] as u32,
                    })
                    .collect(),
            },
            fds: plane_fds,
            image,
        })
    }

    /// Import a dmabuf as a `GL_TEXTURE_2D` on this context, once:
    /// `eglCreateImage(EGL_LINUX_DMA_BUF_EXT)` with the modifier, then
    /// `glEGLImageTargetTexture2DOES`. The fds are closed afterwards (the image holds its own
    /// reference). Validate `{fourcc, modifier}` first (`worker::dmabuf::validate_modifier`).
    pub fn import_dmabuf(
        &self,
        desc: &DmabufDesc,
        fds: Vec<OwnedFd>,
    ) -> Result<ImportedTex, String> {
        static TARGET: OnceLock<usize> = OnceLock::new();
        type TargetFn = unsafe extern "system" fn(u32, *mut c_void);
        let Some(target) = proc(&TARGET, self, "glEGLImageTargetTexture2DOES") else {
            return Err("glEGLImageTargetTexture2DOES missing (GL_OES_EGL_image)".into());
        };
        let n = desc.planes.len();
        if n == 0 || n > 4 || fds.len() < n {
            return Err(format!("dmabuf with {n} planes and {} fds", fds.len()));
        }
        use std::os::fd::AsRawFd;
        let mut a: Vec<egl::Attrib> = vec![
            egl::WIDTH as egl::Attrib,
            desc.w as egl::Attrib,
            egl::HEIGHT as egl::Attrib,
            desc.h as egl::Attrib,
            LINUX_DRM_FOURCC,
            desc.fourcc as egl::Attrib,
        ];
        for (i, p) in desc.planes.iter().enumerate() {
            let k = PLANE_ATTRS[i];
            a.extend_from_slice(&[
                k[0],
                fds[i].as_raw_fd() as egl::Attrib,
                k[1],
                p.offset as egl::Attrib,
                k[2],
                p.stride as egl::Attrib,
                k[3],
                (desc.modifier & 0xffff_ffff) as egl::Attrib,
                k[4],
                (desc.modifier >> 32) as egl::Attrib,
            ]);
        }
        a.push(egl::ATTRIB_NONE);
        let (egl, display, _) = self.egl_parts();
        let image = egl
            .create_image(
                display,
                unsafe { egl::Context::from_ptr(egl::NO_CONTEXT) },
                LINUX_DMA_BUF,
                unsafe { egl::ClientBuffer::from_ptr(std::ptr::null_mut()) },
                &a,
            )
            .map_err(|e| {
                format!(
                    "eglCreateImage(EGL_LINUX_DMA_BUF_EXT) {}x{} fourcc {:#x} modifier {:#018x}: {e}",
                    desc.w, desc.h, desc.fourcc, desc.modifier
                )
            })?;
        drop(fds);
        let image = EglImage { display, image };
        let gl = &self.gl;
        let tex = unsafe {
            let id = gl
                .create_texture()
                .map_err(|e| format!("glGenTextures: {e}"))?;
            gl.bind_texture(glow::TEXTURE_2D, Some(id));
            for (k, v) in [
                (glow::TEXTURE_MIN_FILTER, glow::LINEAR),
                (glow::TEXTURE_MAG_FILTER, glow::LINEAR),
                (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
                (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
            ] {
                gl.tex_parameter_i32(glow::TEXTURE_2D, k, v as i32);
            }
            std::mem::transmute::<usize, TargetFn>(target)(glow::TEXTURE_2D, image.as_ptr());
            let err = gl.get_error();
            gl.bind_texture(glow::TEXTURE_2D, None);
            let tex = Tex {
                id,
                w: desc.w,
                h: desc.h,
            };
            if err != glow::NO_ERROR {
                gl.delete_texture(id);
                return Err(format!("glEGLImageTargetTexture2DOES: GL error {err:#x}"));
            }
            tex
        };
        Ok(ImportedTex {
            tex,
            image: Some(image),
            keep: self.keep_alive(),
        })
    }

    /// The modifiers this display imports `fourcc` with, and whether each is external-only
    /// (`eglQueryDmaBufModifiersEXT`); empty without the extension.
    pub fn dmabuf_modifiers(&self, fourcc: u32) -> Vec<(u64, bool)> {
        static QUERY: OnceLock<usize> = OnceLock::new();
        type QueryFn =
            unsafe extern "system" fn(*mut c_void, i32, i32, *mut u64, *mut u32, *mut i32) -> u32;
        let Some(q) = proc(&QUERY, self, "eglQueryDmaBufModifiersEXT") else {
            return Vec::new();
        };
        let q = unsafe { std::mem::transmute::<usize, QueryFn>(q) };
        let display = self.egl_parts().1.as_ptr();
        let mut n = 0i32;
        if unsafe {
            q(
                display,
                fourcc as i32,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut n,
            )
        } == 0
            || n <= 0
        {
            return Vec::new();
        }
        let mut mods = vec![0u64; n as usize];
        let mut ext = vec![0u32; n as usize];
        if unsafe {
            q(
                display,
                fourcc as i32,
                n,
                mods.as_mut_ptr(),
                ext.as_mut_ptr(),
                &mut n,
            )
        } == 0
        {
            return Vec::new();
        }
        mods.truncate(n.max(0) as usize);
        mods.into_iter()
            .zip(ext.into_iter().map(|e| e != 0))
            .collect()
    }

    /// A `sync_file` fd that signals once every GL command issued so far on this context has
    /// completed: `eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID)` + `glFlush` (**before** the
    /// dup — the fd only exists once the fence command is flushed) +
    /// `eglDupNativeFenceFDANDROID`. Never waits.
    pub fn native_fence(&self) -> Result<OwnedFd, String> {
        static DUP: OnceLock<usize> = OnceLock::new();
        type DupFn = unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32;
        let Some(dup) = proc(&DUP, self, "eglDupNativeFenceFDANDROID") else {
            return Err("EGL_ANDROID_native_fence_sync missing".into());
        };
        let (egl, display, _) = self.egl_parts();
        let sync = unsafe {
            egl.create_sync(
                display,
                SYNC_NATIVE_FENCE,
                &[SYNC_NATIVE_FENCE_FD, NO_NATIVE_FENCE_FD, egl::ATTRIB_NONE],
            )
        }
        .map_err(|e| format!("eglCreateSync(EGL_SYNC_NATIVE_FENCE_ANDROID): {e}"))?;
        unsafe { self.gl.flush() };
        let fd =
            unsafe { std::mem::transmute::<usize, DupFn>(dup)(display.as_ptr(), sync.as_ptr()) };
        let _ = unsafe { egl.destroy_sync(display, sync) };
        if fd < 0 {
            return Err("eglDupNativeFenceFDANDROID failed".into());
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// Make this context's GPU queue wait for `fence` (a `sync_file`) — `eglWaitSync`, the
    /// CPU never waits. EGL takes the fd; on failure it is closed here.
    pub fn gpu_wait_fence(&self, fence: OwnedFd) -> Result<(), String> {
        let (egl, display, _) = self.egl_parts();
        let raw = fence.into_raw_fd();
        let sync = match unsafe {
            egl.create_sync(
                display,
                SYNC_NATIVE_FENCE,
                &[SYNC_NATIVE_FENCE_FD, raw as egl::Attrib, egl::ATTRIB_NONE],
            )
        } {
            Ok(s) => s,
            Err(e) => {
                drop(unsafe { OwnedFd::from_raw_fd(raw) });
                return Err(format!("eglCreateSync(native fence fd): {e}"));
            }
        };
        let r = egl
            .wait_sync(display, sync, 0)
            .map_err(|e| format!("eglWaitSync: {e}"));
        let _ = unsafe { egl.destroy_sync(display, sync) };
        r
    }
}
