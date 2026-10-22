{
  description = "livepaper-pro — live wallpaper manager for Wayland (video + Wallpaper Engine scenes)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      inherit (pkgs) lib;

      version = "0.1.0";

      # Runtime tools the backend shells out to. On NixOS these have no global FHS path, so we bake
      # them onto the wrapper's PATH — this is what makes livepaper "just work" without the user
      # installing ffmpeg/mpvpaper/etc. themselves.
      runtimeTools = with pkgs; [
        ffmpeg # /still thumbnail decode + frozen-frame grabs
        mpvpaper # video wallpapers (spawned via setsid)
        linux-wallpaperengine # Wallpaper Engine scene playback
        mpv # mpvpaper dep + still frames
      ];

      # 1) React UI → static dist/.
      ui = pkgs.buildNpmPackage {
        pname = "livepaper-ui";
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
        pname = "livepaper-backend";
        inherit version;
        src = ./src/livepaper;
        projectFile = "livepaper.csproj";
        nugetDeps = ./deps.json;
        dotnet-sdk = pkgs.dotnet-sdk_10;
        dotnet-runtime = pkgs.dotnet-runtime_10;
        selfContainedBuild = true;
        runtimeId = "linux-x64";
        # executable inside the csproj is named `livepaper`
        executables = [ "livepaper" ];
      };

      # 3) Native transition renderer (wlr-layer-shell + EGL/GLES3, libmpv full-live decode).
      # Absent → transitions no-op (instant cut); present → animated GLSL switches.
      lp-transition = pkgs.stdenv.mkDerivation {
        pname = "lp-transition";
        inherit version;
        src = ./src/native/lp-transition;
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
          install -Dm755 lp-transition $out/bin/lp-transition
          runHook postInstall
        '';
      };

      # 3b) Scene-audio crossfade helper (persistent libpulse context — event-driven volume).
      lp-audio = pkgs.stdenv.mkDerivation {
        pname = "lp-audio";
        inherit version;
        src = ./src/native/lp-audio;
        nativeBuildInputs = [ pkgs.pkg-config ];
        buildInputs = [ pkgs.libpulseaudio ];
        installPhase = ''
          runHook preInstall
          install -Dm755 lp-audio $out/bin/lp-audio
          runHook postInstall
        '';
      };

      # 3c) lp-player (Rust): the "utopia player" compositor that will replace mpvpaper +
      # lp-transition. See docs/superpowers/specs/2026-10-20-utopia-player-design.md and
      # .claude/rules/player-core.md. bindgenHook + pkg-config are wired now even though this
      # task doesn't bindgen anything yet, so Task 10 (libmpv FFI) doesn't have to touch the
      # flake again.
      lp-player = pkgs.rustPlatform.buildRustPackage {
        pname = "lp-player";
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
        # R86: libmpv's nvdec hwdec needs the NVIDIA proprietary driver's libcuda.so.1, which on
        # NixOS lives outside the Nix store at /run/opengl-driver/lib (the standard impure
        # GPU-driver mount `hardware.nvidia` provides) — buildInputs can't express that. --prefix
        # (not --set) so a caller's own LD_LIBRARY_PATH is extended, not clobbered; harmless on
        # non-NVIDIA machines (the path simply doesn't exist, so the prefix contributes nothing).
        postInstall = ''
          wrapProgram $out/bin/lp-player --prefix LD_LIBRARY_PATH : /run/opengl-driver/lib
        '';
      };

      # 4) Electron shell sources (plain JS; electron comes from nixpkgs, not the bundled prebuilt
      # which can't dlopen its libs on NixOS). Keep the 42.x pin — older crash-loops the GPU on
      # NVIDIA + kernel ≥6.12 (see .claude/rules/distribution.md).
      shellSrc = pkgs.runCommand "livepaper-shell-src" { } ''
        mkdir -p $out
        cp -r ${./app/shell}/. $out/
        rm -rf $out/node_modules
      '';

      livepaper = pkgs.stdenvNoCC.mkDerivation {
        pname = "livepaper";
        inherit version;
        dontUnpack = true;
        nativeBuildInputs = [ pkgs.makeWrapper ];

        installPhase = ''
          runHook preInstall
          mkdir -p $out/bin $out/share/livepaper $out/share/applications

          # transitions assets (shaders + manifest + preview frames)
          cp -r ${./transitions} $out/share/livepaper/transitions

          # GUI launcher: electron shell → spawns the backend (--serve) + loads the UI.
          makeWrapper ${pkgs.electron_42}/bin/electron $out/bin/livepaper-ui \
            --add-flags ${shellSrc} \
            --set LP_BACKEND ${backend}/bin/livepaper \
            --set LP_UI_DIR ${ui} \
            --set LP_TRANSITIONS_DIR $out/share/livepaper/transitions \
            --set LP_TRANSITION_BIN ${lp-transition}/bin/lp-transition \
            --set LP_AUDIO_BIN ${lp-audio}/bin/lp-audio \
            --set LP_PLAYER_BIN ${lp-player}/bin/lp-player \
            --prefix PATH : ${lib.makeBinPath runtimeTools}

          # Headless CLI (--restore/--action/daemons/--serve). Bare `livepaper` opens the GUI.
          makeWrapper ${backend}/bin/livepaper $out/bin/livepaper-cli \
            --set LP_UI_DIR ${ui} \
            --set LP_TRANSITIONS_DIR $out/share/livepaper/transitions \
            --set LP_TRANSITION_BIN ${lp-transition}/bin/lp-transition \
            --set LP_AUDIO_BIN ${lp-audio}/bin/lp-audio \
            --set LP_PLAYER_BIN ${lp-player}/bin/lp-player \
            --prefix PATH : ${lib.makeBinPath runtimeTools}

          cat > $out/bin/livepaper <<EOF
          #!${pkgs.runtimeShell}
          # bare invocation → GUI; any flag → headless backend
          if [ \$# -eq 0 ]; then exec $out/bin/livepaper-ui; fi
          exec $out/bin/livepaper-cli "\$@"
          EOF
          chmod +x $out/bin/livepaper

          cat > $out/share/applications/livepaper.desktop <<EOF
          [Desktop Entry]
          Name=Livepaper
          Comment=Live wallpaper manager (Wayland)
          Exec=$out/bin/livepaper-ui
          Type=Application
          Categories=Utility;
          Keywords=wallpaper;live;wayland;video;
          EOF

          runHook postInstall
        '';

        meta = {
          description = "Live wallpaper manager for Wayland (video + Wallpaper Engine scenes)";
          homepage = "https://github.com/kryxzort/livepaper-pro";
          platforms = [ "x86_64-linux" ];
          mainProgram = "livepaper";
        };
      };
    in
    {
      packages.${system} = {
        inherit ui backend lp-transition lp-audio lp-player livepaper;
        default = livepaper;
      };
      apps.${system}.default = {
        type = "app";
        program = "${livepaper}/bin/livepaper";
      };

      # Dev shell for hot-reload (scripts/dev.sh: Vite HMR + `dotnet watch` + native-helper make +
      # `cargo build` for lp-player). `inputsFrom` the native + backend + lp-player derivations
      # gives this shell their EXACT build env — pkg-config path AND the stdenv cc wrapper's RPATH
      # injection, so the make'd lp-transition / lp-audio actually find mpv/wayland/GL at runtime
      # (a raw system gcc would not), and `cargo`/`rustc` resolve the same mpv-unwrapped/wayland/
      # libGL/libxkbcommon/pipewire lp-player links against. Plus dotnet-sdk_10 + node + the
      # runtime tools the dev backend shells out to. On NixOS the systemd dev units run
      # `nix develop -c …`; run the whole thing with `nix develop -c bash scripts/dev.sh`.
      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [
          backend
          lp-transition
          lp-audio
          lp-player
        ];
        packages = [
          pkgs.dotnet-sdk_10
          pkgs.nodejs
          pkgs.cargo
          pkgs.rustc
          pkgs.clippy
          pkgs.rustfmt
          pkgs.rust-analyzer
        ] ++ runtimeTools;
        DOTNET_ROOT = "${pkgs.dotnet-sdk_10}/share/dotnet";
      };
    };
}
