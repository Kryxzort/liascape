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

impl Gfx {
    /// Allocate a `w`×`h` `GL_RGBA8` texture with the brief's fixed defaults (`LINEAR`
    /// min/mag, `CLAMP_TO_EDGE` wrap). Storage is allocated (`tex_image_2d` with no pixel
    /// data) but left uninitialized — callers that need a known starting color clear it
    /// through an `Fbo`.
    pub fn tex(&self, w: u32, h: u32) -> Tex {
        unsafe {
            let id = self
                .gl
                .create_texture()
                .expect("glow: create_texture failed");
            self.gl.bind_texture(glow::TEXTURE_2D, Some(id));
            self.gl.tex_image_2d(
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
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MIN_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_MAG_FILTER,
                glow::LINEAR as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_S,
                glow::CLAMP_TO_EDGE as i32,
            );
            self.gl.tex_parameter_i32(
                glow::TEXTURE_2D,
                glow::TEXTURE_WRAP_T,
                glow::CLAMP_TO_EDGE as i32,
            );
            self.gl.bind_texture(glow::TEXTURE_2D, None);
            Tex { id, w, h }
        }
    }

    /// Wrap `tex` in a new FBO with it bound at `GL_COLOR_ATTACHMENT0`. Leaves `GL_NONE`
    /// bound to `GL_FRAMEBUFFER` on return (never leaves the new FBO bound as a side
    /// effect) and panics if the attachment is incomplete — that's a programming error
    /// (wrong format/size), not a recoverable runtime condition.
    pub fn fbo(&self, tex: &Tex) -> Fbo {
        unsafe {
            let id = self
                .gl
                .create_framebuffer()
                .expect("glow: create_framebuffer failed");
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, Some(id));
            self.gl.framebuffer_texture_2d(
                glow::FRAMEBUFFER,
                glow::COLOR_ATTACHMENT0,
                glow::TEXTURE_2D,
                Some(tex.id),
                0,
            );
            let status = self.gl.check_framebuffer_status(glow::FRAMEBUFFER);
            self.gl.bind_framebuffer(glow::FRAMEBUFFER, None);
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

        let stride = (w as usize) * 4;
        let out = if flip {
            let mut flipped = vec![0u8; pixels.len()];
            for row in 0..h as usize {
                let src = &pixels[row * stride..(row + 1) * stride];
                let dst_row = h as usize - 1 - row;
                flipped[dst_row * stride..(dst_row + 1) * stride].copy_from_slice(src);
            }
            flipped
        } else {
            pixels
        };

        let file = File::create(path)?;
        let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(io::Error::other)?;
        writer.write_image_data(&out).map_err(io::Error::other)?;
        Ok(())
    }
}
