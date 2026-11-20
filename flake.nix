{
  description = "Liascape — live wallpaper manager for Wayland (video + Wallpaper Engine scenes)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      inherit (pkgs) lib;

      # The app's Electron: one major for the flake, app/shell/package.json (+ its `allowScripts` key) and the
      # AppImage (.claude/rules/build-and-packaging.md § Electron). An EOL major is marked insecure by nixpkgs and
      # fails to evaluate: move all three to a supported one together.
      electron = pkgs.electron_45;

      version = "0.1.0";

      # Runtime tools the backend shells out to. On NixOS these have no global FHS path, so we bake
      # them onto the wrapper's PATH — this is what makes liascape "just work" without the user
      # installing ffmpeg/mpvpaper/etc. themselves.
      runtimeTools = with pkgs; [
        ffmpeg # /still thumbnail decode + frozen-frame grabs
        mpvpaper # video wallpapers (spawned via setsid)
        linux-wallpaperengine # Wallpaper Engine scene playback
        mpv # mpvpaper dep + still frames
        libsecret # secret-tool: the Steam sign-in in the system keyring (Helpers/SecretStore.cs; no keyring → a 0600 file)
      ];

      # Fonts for scenes' text: a scene's `systemfont_consolas` asks fontconfig for Consolas like any app does, and the scene
      # worker adds its alias rules (src/player/fontconfig/liascape-scene-fonts.conf, compiled in) plus these folders
      # (LIASCAPE_SCENE_FONT_DIRS, set on the player's wrapper; the worker inherits it). Open stand-ins for the Windows
      # families (docs/decisions.md § "Scene fonts come from fontconfig, not a Windows install"): Liberation (Arial, Times
      # New Roman, Courier New), Carlito / Caladea (Calibri, Cambria), Cascadia Mono (Consolas), Selawik (Segoe UI),
      # Comic Neue (Comic Sans MS), Wine's Tahoma. nixpkgs has no Selawik or Wine fonts package: fetched here from their
      # own releases (OFL, LGPL).
      selawik = pkgs.stdenvNoCC.mkDerivation {
        pname = "selawik";
        version = "1.01";
        src = pkgs.fetchzip {
          url = "https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip";
          hash = "sha256-BbjXJ8HFXrRklMOnGXyZIZeQ5Oksda4AqQXHmNqN6AQ=";
          stripRoot = false;
        };
        installPhase = "install -Dm644 -t $out/share/fonts/truetype *.ttf";
        meta.license = lib.licenses.ofl;
      };
      wine-tahoma = pkgs.runCommand "wine-tahoma-10.0" { meta.license = lib.licenses.lgpl21Plus; } ''
        install -Dm644 ${
          pkgs.fetchurl {
            url = "https://gitlab.winehq.org/wine/wine/-/raw/wine-10.0/fonts/tahoma.ttf";
            hash = "sha256-kPGrrU2gzgPaXSJ37nWpYAzoEtN8kOq3bgg4/6eTflU=";
          }
        } $out/share/fonts/truetype/tahoma.ttf
        install -Dm644 ${
          pkgs.fetchurl {
            url = "https://gitlab.winehq.org/wine/wine/-/raw/wine-10.0/fonts/tahomabd.ttf";
            hash = "sha256-wpNCupmgT5gxk3VvAett6Ub9TTO6C7cGGv8R5whxtvI=";
          }
        } $out/share/fonts/truetype/tahomabd.ttf
      '';
      openSceneFonts = [
        pkgs.liberation_ttf
        pkgs.carlito
        pkgs.caladea
        pkgs.cascadia-code
        selawik
        pkgs.comic-neue
        wine-tahoma
      ];
      # The real core web fonts (Arial, Verdana, Comic Sans MS, Times New Roman, Courier New, Georgia, Impact, Trebuchet MS):
      # nixpkgs' corefonts unpacks Microsoft's own installers, the only form their licence lets anyone pass on, so nothing
      # here ships a Microsoft font. It is unfree: this one package (and nothing else) is allowed for the app's fonts, so
      # `nix build` works without `allowUnfree`; it builds locally (no binary cache serves unfree packages).
      corefonts =
        (import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = p: lib.getName p == "corefonts";
        }).corefonts;
      fontDirs = fonts: lib.concatMapStringsSep ":" (p: "${p}/share/fonts") fonts;

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

      # 3b') LWE (linux-wallpaperengine) `next-v2` core — the scene worker's renderer.
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
          # text objects: `systemfont_*` and glyphs the scene's font lacks are looked up through fontconfig
          pkgs.fontconfig
          # text shaping (GPOS kerning, ligatures), as WE shapes with HarfBuzz
          pkgs.harfbuzz
          pkgs.glm
          pkgs.lz4
          pkgs.zlib
          pkgs.libGL
          # video textures: demux and decode (with NVDEC / VAAPI / Vulkan), the CUDA frames' device
          pkgs.ffmpeg
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

      # 3c) liascape-player (Rust): the compositor that plays wallpapers in place of mpvpaper +
      # liascape-transition. See docs/player/architecture.md and
      # .claude/rules/player/core.md. bindgenHook + pkg-config: the libmpv FFI.
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
        # libmpv's nvdec hwdec needs the NVIDIA proprietary driver's libcuda.so.1, which on
        # NixOS lives outside the Nix store at /run/opengl-driver/lib (the standard impure
        # GPU-driver mount `hardware.nvidia` provides) — buildInputs can't express that. --prefix
        # (not --set) so a caller's own LD_LIBRARY_PATH is extended, not clobbered; harmless on
        # non-NVIDIA machines (the path simply doesn't exist, so the prefix contributes nothing).
        # LIASCAPE_SCENE_FONT_DIRS: the scene fonts above, for every scene worker the player starts (a caller's own value wins).
        postInstall = ''
          wrapProgram $out/bin/liascape-player --prefix LD_LIBRARY_PATH : /run/opengl-driver/lib \
            --suffix PATH : ${pkgs.ffmpeg}/bin \
            --set-default LIASCAPE_SCENE_FONT_DIRS ${fontDirs (openSceneFonts ++ [ corefonts ])}
        '';
      };

      # 4) Electron shell sources (plain JS; electron comes from nixpkgs (`electron` above), not the bundled
      # prebuilt which can't dlopen its libs on NixOS). Only the runtime files, the same list install.sh stages: the
      # UI matrix's probes and CDP helpers stay in the repo.
      shellSrc = pkgs.runCommand "liascape-shell-src" { } ''
        files="$(bash ${./scripts/shell-runtime-files.sh} ${./app/shell})" || exit 1
        while read -r f; do install -Dm644 ${./app/shell}/$f $out/$f; done <<< "$files"
      '';

      liascape = pkgs.stdenvNoCC.mkDerivation {
        pname = "liascape";
        inherit version;
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.makeWrapper ];

        # The same layout install.sh makes (scripts/liascape resolves libexec/ + lib/ relative to itself):
        # bin/liascape, libexec/liascape/<the internal executables>, lib/liascape/{ui,shell,transitions}.
        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin $out/libexec/liascape $out/lib/liascape $out/share/applications

          # transitions assets (shaders + manifest + preview frames), the UI bundle, the Electron shell
          cp -r ${./transitions} $out/lib/liascape/transitions
          ln -s ${ui} $out/lib/liascape/ui
          ln -s ${shellSrc} $out/lib/liascape/shell

          # the internal executables, off PATH (the player finds its scene worker next to its own exe too)
          ln -s ${backend}/bin/liascape-backend $out/libexec/liascape/liascape-backend
          ln -s ${liascape-player}/bin/liascape-player $out/libexec/liascape/liascape-player
          ln -s ${liascape-player}/bin/liascape-scene-worker $out/libexec/liascape/liascape-scene-worker
          ln -s ${liascape-transition}/bin/liascape-transition $out/libexec/liascape/liascape-transition
          ln -s ${liascape-audio}/bin/liascape-audio $out/libexec/liascape/liascape-audio

          # the one command: bare = the app (nixpkgs' electron — the bundled prebuilt can't load its libs
          # here), `liascape <command>` = the backend's CLI, `liascape ctl …` = the player's
          install -Dm755 ${./scripts/liascape} $out/bin/liascape
          patchShebangs $out/bin/liascape
          wrapProgram $out/bin/liascape \
            --set-default LIASCAPE_ELECTRON ${electron}/bin/electron \
            --prefix PATH : ${lib.makeBinPath runtimeTools}

          cat > $out/share/applications/liascape.desktop <<EOF
          [Desktop Entry]
          Name=Liascape
          Comment=Live wallpaper manager (Wayland)
          Exec=$out/bin/liascape
          Type=Application
          Categories=Utility;
          Keywords=wallpaper;live;wayland;video;
          StartupWMClass=liascape
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
          electron
        ] ++ runtimeTools;
        DOTNET_ROOT = "${pkgs.dotnet-sdk_10}/share/dotnet";
        # the app's Electron for the launcher, scripts/agent-window.sh and the UI matrix (scripts/test-ui-matrix.sh)
        LIASCAPE_ELECTRON = "${electron}/bin/electron";
        # Shared compile cache (~/.cache/sccache): every git worktree (one per agent) has its own
        # target/, so without it each one recompiles all dependencies from scratch.
        RUSTC_WRAPPER = "sccache";
        # `cargo build` links liascape-scene-worker against the pinned core (feature `lwe`, default).
        # Patch work on LWE: `LWE_DEV_SRC=<fork checkout> bash scripts/lwe.sh build`, then
        # LIASCAPE_LWE_CORE_DIR=$PWD/build/lwe-core for cargo (UPSTREAM.md § linux-wallpaperengine).
        LIASCAPE_LWE_CORE_DIR = "${lwe-core}";
        # a dev build's scene workers get the package's open scene fonts; corefonts stays out (entering the shell would
        # fetch Microsoft's installers first), so a dev player shows Arial with Liberation Sans unless the system has it
        LIASCAPE_SCENE_FONT_DIRS = fontDirs openSceneFonts;
      };
    };
}
