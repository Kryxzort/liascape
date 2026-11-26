// The core's puppet code (Render/Objects/Puppet.cpp: the MDL loader, the layer mixing and the skinning), compiled in
// from the source `scripts/lwe.sh test` built, against values decoded from real Workshop puppets. No scene is drawn:
// these pin the math the renderer poses a puppet's mesh with (`CImage::updatePuppetPose`).
#include "WallpaperEngine/Render/Objects/Puppet.h"

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace Puppet = WallpaperEngine::Render::Objects::Puppet;

static int g_failed = 0;
static int g_passed = 0;

#define CHECK(cond, ...)                                                                                               \
    do {                                                                                                               \
        if (!(cond)) {                                                                                                 \
            printf ("    FAIL: ");                                                                                     \
            printf (__VA_ARGS__);                                                                                      \
            printf ("\n");                                                                                             \
            return false;                                                                                              \
        }                                                                                                              \
    } while (0)

// an .mdl file written field by field
struct MdlWriter {
    std::string out;
    MdlWriter& u8 (unsigned v) { out.push_back (static_cast<char> (v)); return *this; }
    MdlWriter& u16 (unsigned v) { out.append (reinterpret_cast<const char*> (&v), 2); return *this; }
    MdlWriter& u32 (uint32_t v) { out.append (reinterpret_cast<const char*> (&v), 4); return *this; }
    MdlWriter& f32 (float v) { out.append (reinterpret_cast<const char*> (&v), 4); return *this; }
    MdlWriter& str (const std::string& s) { out += s; out.push_back ('\0'); return *this; }
    // a translation, column-major as the file stores it
    MdlWriter& translation (float x, float y) {
        for (int i = 0; i < 12; i++) {
            f32 (i % 5 == 0 ? 1.0f : 0.0f);
        }
        return f32 (x).f32 (y).f32 (0.0f).f32 (1.0f);
    }
    MdlWriter& section (const std::string& tag, const std::string& body) {
        str (tag);
        u32 (static_cast<uint32_t> (out.size () + 4 + body.size ()));
        out += body;
        return *this;
    }
};

// Workshop 3071833748's puppet (models/ryopw_puppet.mdl: MDLV0019, MDLS0002, MDLA0005), its skeleton as the file
// stores it: per bone the parent, the bone matrix and the explicit matrix (both translations only). The bone matrices
// sit on the parts as the puppet's image lays them out (bone 4 on the fringe, drawn apart at the image's top left); the
// explicit ones are where the parts go (the fringe over the face). The animations kopf1 (52) and kopf2 (54) key every
// bone at its explicit matrix and turn bone 1 (kopf1) and bone 2 (kopf2) about z; the scene plays them as additive
// layers at blend 0.21 and 0.13
struct RealBone {
    int parent;
    float bone[2];
    float rest[2];
};
static const RealBone kRyo[] = {
    { -1, { 71.72308349609375f, -684.1312255859375f }, { 71.72308349609375f, -684.1312255859375f } },
    { 0, { 77.728759765625f, 326.9964599609375f }, { 77.728759765625f, 326.9964599609375f } },
    { 1, { 67.00738525390625f, 431.52813720703125f }, { -80.55961608886719f, -17.879852294921875f } },
    { 2, { -13.40142822265625f, 495.855224609375f }, { -13.40142822265625f, 492.6436462402344f } },
    { 3, { -782.8740234375f, 138.83837890625f }, { -75.12103271484375f, -61.048614501953125f } },
    { 3, { -691.7437744140625f, -667.931640625f }, { -134.1707763671875f, -210.73263549804688f } },
    { 3, { -1058.9449462890625f, -418.6636962890625f }, { -170.61492919921875f, -393.0011901855469f } },
    { 3, { 635.0042724609375f, -611.645263671875f }, { 160.10528564453125f, -222.8482666015625f } },
    { 0, { -756.07080078125f, 221.92770385742188f }, { 7.793212890625f, 170.7904052734375f } },
};
static const int kRyoBones = 9;
// the angles (radians, z) the two animations reach at their frame 30 (1 s at 30 fps), on bones 1 and 2
static const float kKopf1Turn = -0.10576695203781128f;
static const float kKopf2Turn = -0.12655381858348846f;
// a vertex of the fringe, wholly on bone 4: the mesh's (-328, 405.5)
static const float kFringe[2] = { -328.0f, 405.5f };

// the file's sections: one mesh (a triangle of the fringe on bone 4), the skeleton with its explicit matrices (without
// them: `explicitMatrices` false), and the two animations as 3 frames at 1 fps (frame 0, frame 30, frame 0 again: what
// the file's 60 hold at 0, 30 and 60)
static std::string ryo_mdl (bool explicitMatrices = true) {
    MdlWriter w;
    w.str ("MDLV0019").u32 (0x180000f).u32 (1).u32 (1).str ("materials/ryopw.json");
    w.u32 (0); // flags: 16-bit indices
    for (int i = 0; i < 6; i++) {
        w.f32 (0.0f);
    }
    w.u32 (0x180000f);
    MdlWriter verts;
    const float corners[3][2] = { { kFringe[0], kFringe[1] }, { kFringe[0] + 8.0f, kFringe[1] }, { kFringe[0], kFringe[1] + 8.0f } };
    for (const auto& c : corners) {
        verts.f32 (c[0]).f32 (c[1]).f32 (0.0f);
        verts.f32 (0).f32 (0).f32 (1).f32 (1).f32 (0).f32 (0).f32 (1);
        verts.u32 (4).u32 (0).u32 (0).u32 (0).f32 (1).f32 (0).f32 (0).f32 (0);
        verts.f32 (0.3f).f32 (0.3f);
    }
    w.u32 (static_cast<uint32_t> (verts.out.size ()));
    w.out += verts.out;
    w.u32 (6).u16 (0).u16 (1).u16 (2);

    MdlWriter bones;
    bones.u32 (kRyoBones);
    for (const auto& b : kRyo) {
        bones.str ("").u32 (1).u32 (static_cast<uint32_t> (b.parent)).u32 (64).translation (b.bone[0], b.bone[1]).str ("");
    }
    bones.u16 (0).u8 (explicitMatrices ? 1 : 0); // no IK targets; the explicit matrices follow
    for (const auto& b : kRyo) {
        if (explicitMatrices) {
            bones.translation (b.rest[0], b.rest[1]);
        }
    }
    bones.u32 (0); // constraints

    MdlWriter anims;
    anims.u32 (2);
    const struct {
        uint32_t id;
        const char* name;
        int bone;
        float turn;
    } layers[2] = { { 52, "kopf1", 1, kKopf1Turn }, { 54, "kopf2", 2, kKopf2Turn } };
    for (const auto& l : layers) {
        anims.u32 (l.id).u32 (0).str (l.name).str ("loop").f32 (1.0f).u32 (2).u32 (0).u32 (kRyoBones);
        for (int b = 0; b < kRyoBones; b++) {
            anims.u32 (0).u32 (3 * 36);
            for (int k = 0; k < 3; k++) {
                const float z = b == l.bone && k == 1 ? l.turn : 0.0f;
                anims.f32 (kRyo[b].rest[0]).f32 (kRyo[b].rest[1]).f32 (0).f32 (0).f32 (0).f32 (z).f32 (1).f32 (1).f32 (1);
            }
        }
        anims.u32 (0).u8 (0); // v3: no curves, no bone alphas
        anims.u8 (0);         // v4: no blend-shape weights
        for (int i = 0; i < 6; i++) {
            anims.u32 (0); // v5
        }
        anims.u32 (0); // events
    }
    w.section ("MDLS0002", bones.out).section ("MDLA0005", anims.out);
    return w.out;
}

// the fringe vertex posed as CImage::updatePuppetPose does: from the rest pose, kopf1 additive at 0.21 and kopf2
// additive at 0.13, sampled at `time`, skinned by world · bind world⁻¹
static glm::vec3 pose_fringe (const Puppet::Model& model, float time) {
    const std::vector<Puppet::Key> rest = Puppet::restPose (model);
    std::vector<Puppet::Key> pose = rest;
    Puppet::mix (pose, rest, model.animations[0], time, 0.21f, true);
    Puppet::mix (pose, rest, model.animations[1], time, 0.13f, true);
    std::vector<glm::mat4> world, bindWorld;
    Puppet::worldMatrices (model, pose, world);
    Puppet::bindWorldMatrices (model, bindWorld);
    std::vector<glm::mat4> skinning (world.size ());
    for (size_t b = 0; b < world.size (); b++) {
        skinning[b] = world[b] * glm::inverse (bindWorld[b]);
    }
    return Puppet::skin (model.meshes[0].vertices[0], skinning);
}

// the world translation of bone `b` (every matrix here is a translation): its `rest` or `bone` chain
static glm::vec2 chain (int b, bool rest) {
    glm::vec2 at (0.0f);
    for (; b >= 0; b = kRyo[b].parent) {
        at += rest ? glm::vec2 (kRyo[b].rest[0], kRyo[b].rest[1]) : glm::vec2 (kRyo[b].bone[0], kRyo[b].bone[1]);
    }
    return at;
}

// An MDLS v2+ skeleton with explicit matrices rests at them and binds at its bone matrices (WE 2.8.797: the rest pose
// through the getters GH 0x140249ec0 / 0x140249ef0, the inverse binds from the bone matrices in GH 0x14024b710). At frame
// 0 3071833748's additive layers add nothing, so the fringe sits where the rest pose puts it: moved by its bone's rest
// world minus its bind world, (560.2, -652.5) px, from the image's top left onto the face. At frame 30 the layers turn
// it about bones 1 and 2 by 0.21 and 0.13 of the keyed angles. Unpatched the bone matrices were the rest too: each
// additive layer added its keys' distance from them, so the fringe stopped a third of the way, (190.5, -221.9) px
// (3071833748's dark blob over the face, 3102766419's hair beside a bald head)
static bool explicit_matrices_are_the_rest () {
    Puppet::Model model;
    std::string error;
    const std::string file = ryo_mdl ();
    CHECK (Puppet::parse (file.data (), file.size (), model, error) && error.empty (), "the file didn't parse: %s",
           error.c_str ());
    CHECK (model.bones.size () == kRyoBones && model.animations.size () == 2, "%zu bones, %zu animations",
           model.bones.size (), model.animations.size ());

    const glm::vec2 fringe (kFringe[0], kFringe[1]);
    const glm::vec2 placed = fringe + chain (4, true) - chain (4, false);
    const glm::vec3 still = pose_fringe (model, 0.0f);
    printf ("    the fringe at frame 0: (%.2f, %.2f), the rest pose's place (%.2f, %.2f), the mesh's (%.2f, %.2f)\n", still.x,
            still.y, placed.x, placed.y, fringe.x, fringe.y);
    CHECK (std::abs (still.x - placed.x) < 0.01f && std::abs (still.y - placed.y) < 0.01f,
           "the fringe is at (%.2f, %.2f) at frame 0, not (%.2f, %.2f)", still.x, still.y, placed.x, placed.y);

    const std::vector<Puppet::Key> rest = Puppet::restPose (model);
    std::vector<glm::mat4> bindWorld;
    Puppet::bindWorldMatrices (model, bindWorld);
    for (int b = 0; b < kRyoBones; b++) {
        CHECK (std::abs (rest[b].position.x - kRyo[b].rest[0]) < 1e-3f && std::abs (rest[b].position.y - kRyo[b].rest[1]) < 1e-3f,
               "bone %d rests at (%.2f, %.2f), not its explicit matrix (%.2f, %.2f)", b, rest[b].position.x,
               rest[b].position.y, kRyo[b].rest[0], kRyo[b].rest[1]);
        const glm::vec2 bind = chain (b, false);
        CHECK (std::abs (bindWorld[b][3].x - bind.x) < 1e-2f && std::abs (bindWorld[b][3].y - bind.y) < 1e-2f,
               "bone %d binds at (%.2f, %.2f), not its bone matrices' (%.2f, %.2f)", b, bindWorld[b][3].x,
               bindWorld[b][3].y, bind.x, bind.y);
    }

    // frame 30, by hand: bone 1 turns by a about its rest origin, bone 2 by b about its own; the fringe hangs off bone 2
    const glm::vec2 b1 = chain (1, true), b2 = chain (2, true);
    const auto turn = [] (glm::vec2 v, float angle) {
        return glm::vec2 (v.x * std::cos (angle) - v.y * std::sin (angle), v.x * std::sin (angle) + v.y * std::cos (angle));
    };
    const float a = 0.21f * kKopf1Turn, b = 0.13f * kKopf2Turn;
    const glm::vec2 want = b1 + turn (b2 - b1 + turn (placed - b2, b), a);
    const glm::vec3 moved = pose_fringe (model, 1.0f);
    printf ("    the fringe at frame 30: (%.2f, %.2f), by hand (%.2f, %.2f)\n", moved.x, moved.y, want.x, want.y);
    CHECK (std::abs (moved.x - want.x) < 0.05f && std::abs (moved.y - want.y) < 0.05f,
           "the fringe at frame 30 is (%.2f, %.2f), not (%.2f, %.2f)", moved.x, moved.y, want.x, want.y);
    return true;
}

// without the explicit flag the bone matrices are the rest pose as well (every other library puppet: 3414858021,
// 3233141951, …), so the fringe sits where the mesh has it at frame 0
static bool bone_matrices_rest_without_explicit () {
    const std::string file = ryo_mdl (false);
    Puppet::Model model;
    std::string error;
    CHECK (Puppet::parse (file.data (), file.size (), model, error) && error.empty (), "the file didn't parse: %s",
           error.c_str ());
    CHECK (model.animations.size () == 2, "%zu animations", model.animations.size ());
    const std::vector<Puppet::Key> rest = Puppet::restPose (model);
    CHECK (std::abs (rest[4].position.x - kRyo[4].bone[0]) < 1e-3f && std::abs (rest[4].position.y - kRyo[4].bone[1]) < 1e-3f,
           "bone 4 rests at (%.2f, %.2f), not its bone matrix", rest[4].position.x, rest[4].position.y);
    // and the rest pose skins to the mesh as it is
    std::vector<glm::mat4> world, bindWorld;
    Puppet::worldMatrices (model, rest, world);
    Puppet::bindWorldMatrices (model, bindWorld);
    std::vector<glm::mat4> skinning (world.size ());
    for (size_t b = 0; b < world.size (); b++) {
        skinning[b] = world[b] * glm::inverse (bindWorld[b]);
    }
    const glm::vec3 p = Puppet::skin (model.meshes[0].vertices[0], skinning);
    CHECK (std::abs (p.x - kFringe[0]) < 0.01f && std::abs (p.y - kFringe[1]) < 0.01f, "the fringe at rest is (%.2f, %.2f)",
           p.x, p.y);
    return true;
}

static void run (const char* name, bool (*test) ()) {
    printf ("%s\n", name);
    if (test ()) {
        g_passed++;
    } else {
        g_failed++;
    }
}

int main () {
    run ("explicit_matrices_are_the_rest", explicit_matrices_are_the_rest);
    run ("bone_matrices_rest_without_explicit", bone_matrices_rest_without_explicit);
    printf ("puppet_test: %d passed, %d failed\n", g_passed, g_failed);
    return g_failed == 0 ? 0 : 1;
}
