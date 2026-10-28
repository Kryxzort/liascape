{
  description = "liascape — live wallpaper manager for Wayland (video + Wallpaper Engine scenes)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      inherit (pkgs) lib;

      version = "0.1.0";

      # Runtime tools the backend shells out to. On NixOS these have no global FHS path, so we bake
      # them onto the wrapper's PATH — this is what makes liascape "just work" without the user
      # installing ffmpeg/mpvpaper/etc. themselves.
      runtimeTools = with pkgs; [
        ffmpeg # /still thumbnail decode + frozen-frame grabs
        mpvpaper # video wallpapers (spawned via setsid)
        linux-wallpaperengine # Wallpaper Engine scene playback
        mpv # mpvpaper dep + still frames
      ];

      # 1) React UI → static dist/.
      ui = pkgs.buildNpmPackage {
        pname = "liascape-ui";
        inherit version;
        src = ./app/ui;
        npmDepsHash = "sha256-CrYaDAHFfkcwSkwCWmApEtRufKyxB8Qh8UL6aK92q0k=";
        npmBuildScript = "build";
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -r dist/. $out/
          runHook postInstall
        '';
      };

      # 2) C# .NET 10 backend (headless web API + CLI). Self-contained so it carries its own runtime.
      backend = pkgs.buildDotnetModule {
        pname = "liascape-backend";
        inherit version;
        src = ./src/backend;
        projectFile = "liascape-backend.csproj";
        nugetDeps = ./deps.json;
        dotnet-sdk = pkgs.dotnet-sdk_10;
        dotnet-runtime = pkgs.dotnet-runtime_10;
        selfContainedBuild = true;
        runtimeId = "linux-x64";
        # the csproj's AssemblyName: the executable is `liascape-backend`
        executables = [ "liascape-backend" ];
      };

      # 3) Native transition renderer (wlr-layer-shell + EGL/GLES3, libmpv full-live decode).
      # Absent → transitions no-op (instant cut); present → animated GLSL switches.
      liascape-transition = pkgs.stdenv.mkDerivation {
        pname = "liascape-transition";
        inherit version;
        src = ./src/native/liascape-transition;
        nativeBuildInputs = [
          pkgs.pkg-config
          pkgs.wayland-scanner
        ];
        buildInputs = [
          pkgs.wayland # wayland-client + wayland-egl
          pkgs.libGL # egl + glesv2 (libglvnd)
          pkgs.mpv # libmpv render API
        ];
        installPhase = ''
          runHook preInstall
          install -Dm755 liascape-transition $out/bin/liascape-transition
          runHook postInstall
        '';
      };

      # 3b) Scene-audio crossfade helper (persistent libpulse context — event-driven volume).
      liascape-audio = pkgs.stdenv.mkDerivation {
        pname = "liascape-audio";
        inherit version;
        src = ./src/native/liascape-audio;
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.libpulseaudio ];
        installPhase = ''
          runHook preInstall
          install -Dm755 liascape-audio $out/bin/liascape-audio
          runHook postInstall
        '';
      };

      # 3b') LWE (linux-wallpaperengine) `next-v2` core — the scene worker's renderer (Phase 2).
      # third_party/lwe/PIN is the single source of truth: the owner's fork at `rev` = upstream's
      # pinned `next-v2` commit (`base`) + our patches as commits (patches/lwe/*.patch is the same set
      # as `git format-patch`; `scripts/lwe.sh verify` proves it). Fetched by hash, submodules
      # included; only the `linux-wallpaperengine-core` target is built (no CEF/webhelper, no GLFW
      # frontend). Output: lib/liblinux-wallpaperengine-core.so* + include/linux-wallpaperengine/*.h
      # = what `LIASCAPE_LWE_CORE_DIR` points at.
      lwePin = builtins.fromJSON (builtins.readFile ./third_party/lwe/PIN);
      lwe-src = pkgs.fetchFromGitHub {
        owner = lwePin.owner;
        repo = lwePin.name;
        rev = lwePin.rev;
        hash = lwePin.nix_hash;
        fetchSubmodules = true;
      };
      lwe-core = pkgs.stdenv.mkDerivation {
        pname = "lwe-core";
        version = "${lwePin.version}-${builtins.substring 0 7 lwePin.rev}";
        src = lwe-src;
        nativeBuildInputs = [
          pkgs.cmake
          pkgs.pkg-config
        ];
        buildInputs = [
          pkgs.SDL2
          pkgs.freetype
          pkgs.glm
          pkgs.lz4
          pkgs.zlib
          pkgs.libGL
          pkgs.ffmpeg
          pkgs.mpv-unwrapped
        ];
        cmakeFlags = [
          "-DWPBUILD_CORE=ON"
          "-DWPBUILD_WEBHELPER=OFF"
          "-DWPBUILD_FRONTEND=OFF"
          "-DWPBUILD_DEVVIEWER=OFF"
          "-DWPBUILD_TESTS=OFF"
          "-DWPBUILD_VERSION_OVERRIDE=${lwePin.version}"
        ];
        # the core *target* only: `all` would compile the dev-viewer/webhelper OBJECT libraries,
        # which are declared before their option gate and need GLFW/CEF headers
        buildPhase = ''
          runHook preBuild
          cmake --build . --target linux-wallpaperengine-core -j$NIX_BUILD_CORES
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/lib $out/include/linux-wallpaperengine
          cp -P lib/liblinux-wallpaperengine-core.so* $out/lib/
          cp ../include/linux-wallpaperengine/*.h generated/version.h $out/include/linux-wallpaperengine/
          echo ${lwePin.rev} > $out/REV
          runHook postInstall
        '';
      };

      # 3c) liascape-player (Rust): the "utopia player" compositor that will replace mpvpaper +
      # liascape-transition. See docs/superpowers/specs/2026-10-20-utopia-player-design.md and
      # .claude/rules/player-core.md. bindgenHook + pkg-config are wired now even though this
      # task doesn't bindgen anything yet, so Task 10 (libmpv FFI) doesn't have to touch the
      # flake again.
      liascape-player = pkgs.rustPlatform.buildRustPackage {
        pname = "liascape-player";
        inherit version;
        src = ./src/player;
        cargoLock.lockFile = ./src/player/Cargo.lock;
        nativeBuildInputs = [
          pkgs.pkg-config
          pkgs.rustPlatform.bindgenHook
          pkgs.makeWrapper
        ];
        buildInputs = [
          pkgs.mpv-unwrapped
          pkgs.wayland
          pkgs.libGL
          pkgs.libxkbcommon
          pkgs.pipewire
        ];
        # The dropout detector's tests decode reference audio with ffmpeg (CPU only — they run
        # in the sandbox; the GPU tests SKIP there without an EGL device).
        nativeCheckInputs = [ pkgs.ffmpeg ];
        # feature `lwe` (default): liascape-scene-worker links LWE's core (build.rs; RUNPATH = this)
        LIASCAPE_LWE_CORE_DIR = "${lwe-core}";
        # R86: libmpv's nvdec hwdec needs the NVIDIA proprietary driver's libcuda.so.1, which on
        # NixOS lives outside the Nix store at /run/opengl-driver/lib (the standard impure
        # GPU-driver mount `hardware.nvidia` provides) — buildInputs can't express that. --prefix
        # (not --set) so a caller's own LD_LIBRARY_PATH is extended, not clobbered; harmless on
        # non-NVIDIA machines (the path simply doesn't exist, so the prefix contributes nothing).
        postInstall = ''
          wrapProgram $out/bin/liascape-player --prefix LD_LIBRARY_PATH : /run/opengl-driver/lib \
            --suffix PATH : ${pkgs.ffmpeg}/bin
        '';
      };

      # 4) Electron shell sources (plain JS; electron comes from nixpkgs, not the bundled prebuilt
      # which can't dlopen its libs on NixOS). Keep the 42.x pin — older crash-loops the GPU on
      # NVIDIA + kernel ≥6.12 (see .claude/rules/distribution.md).
      shellSrc = pkgs.runCommand "liascape-shell-src" { } ''
        mkdir -p $out
        cp -r ${./app/shell}/. $out/
        rm -rf $out/node_modules
      '';

      liascape = pkgs.stdenvNoCC.mkDerivation {
        pname = "liascape";
        inherit version;
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.makeWrapper ];

        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin $out/share/liascape $out/share/applications

          # transitions assets (shaders + manifest + preview frames)
          cp -r ${./transitions} $out/share/liascape/transitions

          # GUI launcher: electron shell → spawns the backend (--serve) + loads the UI.
          makeWrapper ${pkgs.electron_42}/bin/electron $out/bin/liascape-ui \
            --add-flags ${shellSrc} \
            --set LIASCAPE_BACKEND ${backend}/bin/liascape-backend \
            --set LIASCAPE_UI_DIR ${ui} \
            --set LIASCAPE_TRANSITIONS_DIR $out/share/liascape/transitions \
            --set LIASCAPE_TRANSITION_BIN ${liascape-transition}/bin/liascape-transition \
            --set LIASCAPE_AUDIO_BIN ${liascape-audio}/bin/liascape-audio \
            --set LIASCAPE_PLAYER_BIN ${liascape-player}/bin/liascape-player \
            --prefix PATH : ${lib.makeBinPath runtimeTools}

          # Headless CLI (--restore/--action/daemons/--serve). Bare `liascape` opens the GUI.
          makeWrapper ${backend}/bin/liascape-backend $out/bin/liascape-cli \
            --set LIASCAPE_UI_DIR ${ui} \
            --set LIASCAPE_TRANSITIONS_DIR $out/share/liascape/transitions \
            --set LIASCAPE_TRANSITION_BIN ${liascape-transition}/bin/liascape-transition \
            --set LIASCAPE_AUDIO_BIN ${liascape-audio}/bin/liascape-audio \
            --set LIASCAPE_PLAYER_BIN ${liascape-player}/bin/liascape-player \
            --prefix PATH : ${lib.makeBinPath runtimeTools}

          cat > $out/bin/liascape <<EOF
          #!${pkgs.runtimeShell}
          # bare invocation → GUI; any flag → headless backend
          if [ \$# -eq 0 ]; then exec $out/bin/liascape-ui; fi
          exec $out/bin/liascape-cli "\$@"
          EOF
          chmod +x $out/bin/liascape

          cat > $out/share/applications/liascape.desktop <<EOF
          [Desktop Entry]
          Name=Liascape
          Comment=Live wallpaper manager (Wayland)
          Exec=$out/bin/liascape-ui
          Type=Application
          Categories=Utility;
          Keywords=wallpaper;live;wayland;video;
          EOF

          runHook postInstall
        '';

        meta = {
          description = "Live wallpaper manager for Wayland (video + Wallpaper Engine scenes)";
          homepage = "https://github.com/Kryxzort/liascape";
          platforms = [ "x86_64-linux" ];
          mainProgram = "liascape";
        };
      };
    in
    {
      packages.${system} = {
        inherit
          ui
          backend
          liascape-transition
          liascape-audio
          lwe-core
          liascape-player
          liascape
          ;
        default = liascape;
      };
      apps.${system}.default = {
        type = "app";
        program = "${liascape}/bin/liascape";
      };

      # Dev shell for hot-reload (scripts/dev.sh: Vite HMR + `dotnet watch` + native-helper make +
      # `cargo build` for liascape-player). `inputsFrom` the native + backend + liascape-player derivations
      # gives this shell their EXACT build env — pkg-config path AND the stdenv cc wrapper's RPATH
      # injection, so the make'd liascape-transition / liascape-audio actually find mpv/wayland/GL at runtime
      # (a raw system gcc would not), and `cargo`/`rustc` resolve the same mpv-unwrapped/wayland/
      # libGL/libxkbcommon/pipewire liascape-player links against. Plus dotnet-sdk_10 + node + the
      # runtime tools the dev backend shells out to. On NixOS the systemd dev units run
      # `nix develop -c …`; run the whole thing with `nix develop -c bash scripts/dev.sh`.
      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [
          backend
          liascape-transition
          liascape-audio
          liascape-player
          lwe-core # cmake + SDL2/freetype/glm/lz4/zlib/GL: `scripts/lwe.sh build` for patch work
        ];
        packages = [
          pkgs.dotnet-sdk_10
          pkgs.nodejs
          pkgs.cargo
          pkgs.rustc
          pkgs.clippy
          pkgs.rustfmt
          pkgs.rust-analyzer
          pkgs.sccache
        ] ++ runtimeTools;
        DOTNET_ROOT = "${pkgs.dotnet-sdk_10}/share/dotnet";
        # Shared compile cache (~/.cache/sccache): every git worktree (one per agent) has its own
        # target/, so without it each one recompiles all dependencies from scratch.
        RUSTC_WRAPPER = "sccache";
        # `cargo build` links liascape-scene-worker against the pinned core (feature `lwe`, default).
        # Patch work on LWE: `LWE_DEV_SRC=<fork checkout> bash scripts/lwe.sh build`, then
        # LIASCAPE_LWE_CORE_DIR=$PWD/build/lwe-core for cargo (UPSTREAM.md § linux-wallpaperengine).
        LIASCAPE_LWE_CORE_DIR = "${lwe-core}";
      };
    };
}
