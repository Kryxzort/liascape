//! The synthetic renderer (plan D7): draws `lp_player::scene::synthetic`'s patterns with one
//! fragment shader — integer maths, so the probe pixels the tests predict are bit-exact.
//! Image orientation as LWE's core (R25): image top at texture row 0 = `gl_FragCoord.y` 0,
//! no flip anywhere.

use glow::HasContext;
use lp_player::gfx::{Fbo, Gfx};
use lp_player::scene::synthetic::{Fail, Pattern, SyntheticSpec};

const VS: &str = "#version 330 core
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}
";

const FS: &str = "#version 330 core
uniform int u_pattern;
uniform int u_seq;
uniform vec3 u_rgb;
uniform vec3 u_rgb2;
uniform float u_alpha;
uniform ivec2 u_size;
uniform int u_work;
uniform vec2 u_pointer;
uniform float u_level;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy); // p.y = image row from the top (R25)
  float acc = 0.0; // optional GPU load (gpu_work), never changes a pixel
  for (int i = 0; i < u_work; i++) acc += sin(float(i) * 0.001 + gl_FragCoord.x);
  if (acc == 12345.678) discard;
  vec3 c;
  if (u_pattern == 0) {
    int n = u_seq;
    if (p.x < 64 && p.y < 64) {
      c = vec3(float(n & 255), float((n >> 8) & 255), 0.0) / 255.0;
    } else if (p.x >= u_size.x - 16 && p.y >= u_size.y - 16) {
      int x = p.x - (u_size.x - 16);
      int y = p.y - (u_size.y - 16);
      int m = n & 65535;
      c = vec3(float((x * 16 + m) & 255), float((y * 16 + 2 * m) & 255),
               float((x + y + 3 * m) & 255)) / 255.0;
    } else {
      c = vec3(32.0) / 255.0;
    }
  } else if (u_pattern == 1) {
    c = u_rgb;
  } else if (u_pattern == 2) {
    c = p.y < u_size.y / 2 ? u_rgb : u_rgb2;
  } else if (u_pattern == 3) {
    c = distance(vec2(p), u_pointer) < 16.0 ? u_rgb : u_rgb2;
  } else {
    c = vec3(u_level);
  }
  o = vec4(c, u_alpha);
}
";

pub struct Synthetic {
    spec: SyntheticSpec,
    prog: glow::Program,
    loc: Vec<Option<glow::UniformLocation>>,
}

const UNIFORMS: [&str; 9] = [
    "u_pattern",
    "u_seq",
    "u_rgb",
    "u_rgb2",
    "u_alpha",
    "u_size",
    "u_work",
    "u_pointer",
    "u_level",
];

fn rgb(c: [u8; 3]) -> (f32, f32, f32) {
    (
        c[0] as f32 / 255.0,
        c[1] as f32 / 255.0,
        c[2] as f32 / 255.0,
    )
}

impl Synthetic {
    /// `fail: build` refuses like a scene whose first render produced nothing.
    pub fn new(gfx: &Gfx, spec: SyntheticSpec) -> Result<Synthetic, String> {
        if spec.fail == Some(Fail::Build) {
            return Err(
                "synthetic scene: build failed (fail: build) — the first render \
                        produced nothing"
                    .into(),
            );
        }
        let prog = gfx.program(VS, FS)?;
        let loc = UNIFORMS
            .iter()
            .map(|u| unsafe { gfx.gl.get_uniform_location(prog, u) })
            .collect();
        Ok(Synthetic { spec, prog, loc })
    }

    /// Draw frame `seq` into `fbo` (`w`×`h`), then force alpha to 1 (LWE's core leaves 0
    /// in every pixel; the compositor composes premultiplied, so the worker must).
    #[allow(clippy::too_many_arguments)]
    pub fn render(
        &self,
        gfx: &Gfx,
        fbo: &Fbo,
        w: u32,
        h: u32,
        seq: u64,
        level: f32,
        pointer: (f32, f32),
    ) {
        let gl = &gfx.gl;
        let s = &self.spec;
        let pattern = match s.pattern {
            Pattern::FrameIndex => 0,
            Pattern::Solid => 1,
            Pattern::SplitTb => 2,
            Pattern::PointerDot => 3,
            Pattern::InputLevel => 4,
        };
        let l = |i: usize| self.loc[i].as_ref();
        unsafe {
            gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo.id));
            gl.viewport(0, 0, w as i32, h as i32);
            gl.disable(glow::BLEND);
            gl.disable(glow::SCISSOR_TEST);
            gl.use_program(Some(self.prog));
            gl.uniform_1_i32(l(0), pattern);
            gl.uniform_1_i32(l(1), (seq & 0x7fff_ffff) as i32);
            let (r, g, b) = rgb(s.rgb);
            gl.uniform_3_f32(l(2), r, g, b);
            let (r, g, b) = rgb(s.rgb2);
            gl.uniform_3_f32(l(3), r, g, b);
            gl.uniform_1_f32(l(4), s.alpha);
            gl.uniform_2_i32(l(5), w as i32, h as i32);
            gl.uniform_1_i32(l(6), s.gpu_work as i32);
            gl.uniform_2_f32(l(7), pointer.0, pointer.1);
            gl.uniform_1_f32(l(8), level);
            gl.bind_vertex_array(Some(gfx.empty_vao()));
            gl.draw_arrays(glow::TRIANGLES, 0, 3);
            // Force alpha = 1 without touching colour.
            gl.color_mask(false, false, false, true);
            gl.clear_color(0.0, 0.0, 0.0, 1.0);
            gl.clear(glow::COLOR_BUFFER_BIT);
            gl.color_mask(true, true, true, true);
            gl.bind_vertex_array(None);
            gl.use_program(None);
            gl.bind_framebuffer(glow::FRAMEBUFFER, None);
        }
    }
}
