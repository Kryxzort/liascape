//! GL-level helpers built on top of [`super::egl::Gfx`]: textures, FBOs, shader programs,
//! the shared empty VAO, and PNG readback. Everything here assumes a [`Gfx`]'s context is
//! already current on the calling thread (true for the lifetime of every `Gfx` this crate
//! creates — nothing migrates a context between threads).

use std::fs::File;
use std::io;
use std::io::BufWriter;
use std::path::Path;

use glow::HasContext;

use super::egl::Gfx;

/// A 2D texture this crate owns: `GL_RGBA8`, `LINEAR` min/mag filtering, `CLAMP_TO_EDGE`
/// wrap on both axes (brief's texture defaults — every texture `Gfx::tex` creates gets
/// exactly these, no per-call knobs yet because nothing needs them before Task 8).
pub struct Tex {
    pub id: glow::Texture,
    pub w: u32,
    pub h: u32,
}

/// A framebuffer with `Tex` bound at `GL_COLOR_ATTACHMENT0`. Doesn't own the texture (a
/// `Tex` can be re-wrapped in a fresh `Fbo` as many times as needed — [`Gfx::write_png`]
/// and `tests/common::read_rgba` both do this through a short-lived FBO rather than
/// keeping one around per texture).
pub struct Fbo {
    pub id: glow::Framebuffer,
}

/// [`Gfx::tex`] on any context (Phase 2: the render worker's own, `sources::render_worker`):
/// a `w`×`h` `GL_RGBA8` texture with the fixed defaults. Textures are shared across a share
/// group, so one made on the worker's context is sampled by the compositor's too.
pub(crate) fn new_tex(gl: &glow::Context, w: u32, h: u32) -> Tex {
    unsafe {
        let id = gl.create_texture().expect("glow: create_texture failed");
        gl.bind_texture(glow::TEXTURE_2D, Some(id));
        gl.tex_image_2d(
            glow::TEXTURE_2D,
            0,
            glow::RGBA8 as i32,
            w as i32,
            h as i32,
            0,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            glow::PixelUnpackData::Slice(None),
        );
        for (k, v) in [
            (glow::TEXTURE_MIN_FILTER, glow::LINEAR),
            (glow::TEXTURE_MAG_FILTER, glow::LINEAR),
            (glow::TEXTURE_WRAP_S, glow::CLAMP_TO_EDGE),
            (glow::TEXTURE_WRAP_T, glow::CLAMP_TO_EDGE),
        ] {
            gl.tex_parameter_i32(glow::TEXTURE_2D, k, v as i32);
        }
        gl.bind_texture(glow::TEXTURE_2D, None);
        Tex { id, w, h }
    }
}

/// [`Gfx::fbo`] on any context. FBOs (container objects) are **not** shared across a share
/// group: one made on the render worker's context is only usable there.
pub(crate) fn new_fbo(gl: &glow::Context, tex: &Tex) -> Fbo {
    unsafe {
        let id = gl
            .create_framebuffer()
            .expect("glow: create_framebuffer failed");
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(id));
        gl.framebuffer_texture_2d(
            glow::FRAMEBUFFER,
            glow::COLOR_ATTACHMENT0,
            glow::TEXTURE_2D,
            Some(tex.id),
            0,
        );
        let status = gl.check_framebuffer_status(glow::FRAMEBUFFER);
        gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        assert_eq!(
            status,
            glow::FRAMEBUFFER_COMPLETE,
            "Gfx::fbo: incomplete framebuffer (status 0x{status:x}) for a {}x{} texture",
            tex.w,
            tex.h
        );
        Fbo { id }
    }
}

impl Gfx {
    /// Allocate a `w`×`h` `GL_RGBA8` texture with the brief's fixed defaults (`LINEAR`
    /// min/mag, `CLAMP_TO_EDGE` wrap). Storage is allocated (`tex_image_2d` with no pixel
    /// data) but left uninitialized — callers that need a known starting color clear it
    /// through an `Fbo`.
    pub fn tex(&self, w: u32, h: u32) -> Tex {
        new_tex(&self.gl, w, h)
    }

    /// Wrap `tex` in a new FBO with it bound at `GL_COLOR_ATTACHMENT0`. Leaves `GL_NONE`
    /// bound to `GL_FRAMEBUFFER` on return (never leaves the new FBO bound as a side
    /// effect) and panics if the attachment is incomplete — that's a programming error
    /// (wrong format/size), not a recoverable runtime condition.
    pub fn fbo(&self, tex: &Tex) -> Fbo {
        new_fbo(&self.gl, tex)
    }

    /// Compile and link a shader program from GLSL source. On failure, the error string
    /// names which stage failed (`"vertex"`, `"fragment"`, or `"link"`) and includes the
    /// driver's full info log verbatim — never truncated, never summarized.
    pub fn program(&self, vs: &str, fs: &str) -> Result<glow::Program, String> {
        unsafe {
            let vertex = self.compile_shader(glow::VERTEX_SHADER, "vertex", vs)?;
            let fragment = self.compile_shader(glow::FRAGMENT_SHADER, "fragment", fs)?;

            let program = self
                .gl
                .create_program()
                .map_err(|e| format!("link: create_program failed: {e}"))?;
            self.gl.attach_shader(program, vertex);
            self.gl.attach_shader(program, fragment);
            self.gl.link_program(program);

            // The shader objects aren't needed after linking regardless of outcome.
            self.gl.delete_shader(vertex);
            self.gl.delete_shader(fragment);

            if self.gl.get_program_link_status(program) {
                Ok(program)
            } else {
                let log = self.gl.get_program_info_log(program);
                self.gl.delete_program(program);
                Err(format!("link: program link failed:\n{log}"))
            }
        }
    }

    /// Compile one shader stage; `stage` is only used to label the error message.
    unsafe fn compile_shader(
        &self,
        ty: u32,
        stage: &str,
        src: &str,
    ) -> Result<glow::Shader, String> {
        unsafe {
            let shader = self
                .gl
                .create_shader(ty)
                .map_err(|e| format!("{stage}: create_shader failed: {e}"))?;
            self.gl.shader_source(shader, src);
            self.gl.compile_shader(shader);
            if self.gl.get_shader_compile_status(shader) {
                Ok(shader)
            } else {
                let log = self.gl.get_shader_info_log(shader);
                self.gl.delete_shader(shader);
                Err(format!("{stage}: shader compile failed:\n{log}"))
            }
        }
    }

    /// The crate-wide empty VAO: core-profile GL requires *some* vertex array object
    /// bound even for a draw that reads nothing from a vertex buffer (a fullscreen
    /// triangle built from `gl_VertexID` alone, Task 8's approach). Created once per
    /// `Gfx` and reused — callers never need to manage or delete it themselves; it's
    /// dropped along with the GL context it belongs to.
    pub fn empty_vao(&self) -> glow::VertexArray {
        if let Some(vao) = self.empty_vao.get() {
            return vao;
        }
        let vao = unsafe {
            self.gl
                .create_vertex_array()
                .expect("glow: create_vertex_array failed")
        };
        self.empty_vao.set(Some(vao));
        vao
    }

    /// Read the whole texture back and write it to `path` as a standard **top-down** PNG
    /// (row 0 = the top of the image, matching every common image viewer/format).
    ///
    /// GL's own row order is **bottom-left origin**: `glReadPixels` row 0 is the *bottom*
    /// of the image (same convention `read_rgba` documents in `tests/common`). This
    /// function flips rows while copying into the PNG buffer so callers never have to
    /// think about GL's orientation when looking at the file on disk.
    pub fn write_png(&self, tex: &Tex, path: impl AsRef<Path>) -> io::Result<()> {
        self.write_png_rows(tex, path, true)
    }

    /// [`Gfx::write_png`] for a raw **source** texture, whose row 0 already holds the
    /// image's top (R25: `t = 0` = image top, the layout `gfx::compose` flips once) — so
    /// no flip here; the PNG is upright too (`capture` of a source, Task 12).
    pub fn write_png_source(&self, tex: &Tex, path: impl AsRef<Path>) -> io::Result<()> {
        self.write_png_rows(tex, path, false)
    }

    fn write_png_rows(&self, tex: &Tex, path: impl AsRef<Path>, flip: bool) -> io::Result<()> {
        self.read_back(tex, flip).write_png(path)
    }

    /// The texture read back now (synchronously: the GPU is waited for and the pixels copied
    /// here) — [`Gfx::write_png`] / [`Gfx::write_png_source`]. `top_down`: flip GL's
    /// bottom-up rows when encoding. `capture` uses [`Gfx::start_read_back`] instead.
    pub fn read_back(&self, tex: &Tex, top_down: bool) -> Readback {
        let (w, h) = (tex.w, tex.h);
        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        unsafe {
            let fbo = self.fbo(tex);
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
            self.gl.read_pixels(
                0,
                0,
                w as i32,
                h as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::Slice(Some(&mut pixels)),
            );
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            self.gl.delete_framebuffer(fbo.id);
        }
        Readback {
            w,
            h,
            pixels,
            flip: top_down,
        }
    }

    /// Start reading `tex` back **without waiting**: `glReadPixels` into a pixel-pack buffer
    /// (the GPU copies, in command order — the picture as of now) + a fence. `spare`: a
    /// buffer a finished readback gave back ([`Gfx::end_read_back`]) — reused when its size
    /// fits, else freed. Poll [`Gfx::map_read_back`]; release with [`Gfx::end_read_back`].
    /// Measured on the loop (3840×1080): 0.1 ms into a reused buffer, 2.7–7.6 ms the first
    /// time a buffer of that size is used (the driver pins its 16 MB), where the synchronous
    /// [`Gfx::read_back`] took 1.6–10 ms every time (the GPU wait + a 16 MB copy into fresh
    /// pages).
    pub fn start_read_back(
        &self,
        tex: &Tex,
        top_down: bool,
        spare: Option<PackBuffer>,
    ) -> PendingReadback {
        let (w, h) = (tex.w, tex.h);
        let len = (w as usize) * (h as usize) * 4;
        unsafe {
            let buf = match spare {
                Some(b) if b.len == len => b.buf,
                other => {
                    if let Some(b) = other {
                        self.gl.delete_buffer(b.buf);
                    }
                    let buf = self.gl.create_buffer().expect("glow: create_buffer failed");
                    self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(buf));
                    self.gl.buffer_data_size(
                        glow::PIXEL_PACK_BUFFER,
                        len as i32,
                        glow::STREAM_READ,
                    );
                    buf
                }
            };
            self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(buf));
            let fbo = self.fbo(tex);
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
            self.gl.read_pixels(
                0,
                0,
                w as i32,
                h as i32,
                glow::RGBA,
                glow::UNSIGNED_BYTE,
                glow::PixelPackData::BufferOffset(0),
            );
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
            self.gl.delete_framebuffer(fbo.id);
            self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
            let fence = self.gl.fence_sync(glow::SYNC_GPU_COMMANDS_COMPLETE, 0).ok();
            self.gl.flush();
            PendingReadback {
                buf,
                fence,
                len,
                w,
                h,
                flip: top_down,
                mapped: false,
            }
        }
    }

    /// The pixels of `p` once the GPU's copy is done (`None` = not yet; never waits — or
    /// waits up to `wait` when given, for a shutdown): the buffer is mapped and stays so until
    /// [`Gfx::end_read_back`]; the returned view may be read on any thread until then.
    pub fn map_read_back(
        &self,
        p: &mut PendingReadback,
        wait: Option<std::time::Duration>,
    ) -> Option<MappedPixels> {
        if p.mapped {
            return None;
        }
        unsafe {
            if let Some(f) = p.fence {
                let ns = wait.map_or(0, |d| d.as_nanos().min(i32::MAX as u128) as i32);
                let r = self
                    .gl
                    .client_wait_sync(f, glow::SYNC_FLUSH_COMMANDS_BIT, ns);
                if r == glow::TIMEOUT_EXPIRED || r == glow::WAIT_FAILED {
                    return None;
                }
            }
            self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(p.buf));
            let ptr = self.gl.map_buffer_range(
                glow::PIXEL_PACK_BUFFER,
                0,
                p.len as i32,
                glow::MAP_READ_BIT,
            );
            self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
            if ptr.is_null() {
                return None;
            }
            p.mapped = true;
            Some(MappedPixels {
                ptr,
                len: p.len,
                w: p.w,
                h: p.h,
                flip: p.flip,
            })
        }
    }

    /// Unmap `p` (after every [`MappedPixels`] of it is gone) and give its buffer back for
    /// the next [`Gfx::start_read_back`] (or [`Gfx::free_pack_buffer`]).
    pub fn end_read_back(&self, p: PendingReadback) -> PackBuffer {
        unsafe {
            if p.mapped {
                self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, Some(p.buf));
                self.gl.unmap_buffer(glow::PIXEL_PACK_BUFFER);
                self.gl.bind_buffer(glow::PIXEL_PACK_BUFFER, None);
            }
            if let Some(f) = p.fence {
                self.gl.delete_sync(f);
            }
        }
        PackBuffer {
            buf: p.buf,
            len: p.len,
        }
    }

    /// Free a pixel-pack buffer [`Gfx::end_read_back`] gave back.
    pub fn free_pack_buffer(&self, b: PackBuffer) {
        unsafe { self.gl.delete_buffer(b.buf) }
    }
}

/// A texture's pixels read back (RGBA8, GL row order) by [`Gfx::read_back`] — no GL left:
/// `Send`, encoded to a PNG on whatever thread calls [`Readback::write_png`].
pub struct Readback {
    pub w: u32,
    pub h: u32,
    pixels: Vec<u8>,
    flip: bool,
}

impl Readback {
    /// Encode (fdeflate's `Fast`) and write `path` as a top-down PNG.
    pub fn write_png(self, path: impl AsRef<Path>) -> io::Result<()> {
        encode_png(path.as_ref(), self.w, self.h, &self.pixels, self.flip)
    }
}

/// A pixel-pack buffer of `len` bytes, free for another [`Gfx::start_read_back`] (a GL
/// object of the context that made it).
pub struct PackBuffer {
    buf: glow::Buffer,
    len: usize,
}

/// A readback in flight on the GPU ([`Gfx::start_read_back`]): a pixel-pack buffer + its
/// fence. GL objects of the context that made it — released there ([`Gfx::end_read_back`]).
pub struct PendingReadback {
    buf: glow::Buffer,
    fence: Option<glow::Fence>,
    len: usize,
    pub w: u32,
    pub h: u32,
    flip: bool,
    mapped: bool,
}

/// The mapped pixels of a [`PendingReadback`] ([`Gfx::map_read_back`]): readable on any
/// thread (it is plain process memory) until the loop's [`Gfx::end_read_back`] — the owner
/// (`api::capture`) drops this view before that.
pub struct MappedPixels {
    ptr: *const u8,
    len: usize,
    pub w: u32,
    pub h: u32,
    flip: bool,
}

// SAFETY: the mapping is ordinary memory, valid until `end_read_back`, which only runs once
// the thread holding this view gave it back (see `api::capture`).
unsafe impl Send for MappedPixels {}

impl MappedPixels {
    /// Encode (fdeflate's `Fast`) and write `path` as a top-down PNG.
    pub fn write_png(&self, path: impl AsRef<Path>) -> io::Result<()> {
        let data = unsafe { std::slice::from_raw_parts(self.ptr, self.len) };
        encode_png(path.as_ref(), self.w, self.h, data, self.flip)
    }
}

/// `w`×`h` RGBA8 `pixels` (GL row order) → a top-down PNG at `path` (`flip`: the rows are
/// bottom-up, as GL reads an output's picture; a source texture already holds its top row
/// first, R25).
fn encode_png(path: &Path, w: u32, h: u32, pixels: &[u8], flip: bool) -> io::Result<()> {
    let stride = (w as usize) * 4;
    let flipped;
    let out: &[u8] = if flip {
        let mut v = vec![0u8; pixels.len()];
        for row in 0..h as usize {
            let src = &pixels[row * stride..(row + 1) * stride];
            let dst_row = h as usize - 1 - row;
            v[dst_row * stride..(dst_row + 1) * stride].copy_from_slice(src);
        }
        flipped = v;
        &flipped
    } else {
        pixels
    };
    let file = File::create(path)?;
    let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    // fdeflate's PNG-tuned mode: the default (`Balanced`) took 820–875 ms for a 3840×1080
    // scene frame (Task 13, when `capture` still encoded on the loop); `Fast` 39–112 ms —
    // still the reply's latency now that it encodes on `lp-capture`.
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(io::Error::other)?;
    writer.write_image_data(out).map_err(io::Error::other)?;
    Ok(())
}
