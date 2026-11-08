{pkgs}: let
  inherit (pkgs.stdenv.hostPlatform) system;
in
  pkgs.stdenvNoCC.mkDerivation {
    name = "dot-agents-pi-node-modules";

    src = pkgs.runCommand "pi-extensions-runtime-source" {} ''
      mkdir -p $out
      cp ${../pi/package.json} $out/package.json
      cp ${../pi/package-lock.json} $out/package-lock.json
    '';

    nativeBuildInputs = [pkgs.nodejs pkgs.cacert];

    buildPhase = ''
      runHook preBuild

      # npm needs a writable home and cert bundle inside the sandbox
      export HOME=$TMPDIR
      export npm_config_cache=$TMPDIR/.npm
      export NODE_EXTRA_CA_CERTS="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"

      cp $src/package.json ./package.json
      cp $src/package-lock.json ./package-lock.json
      # Runtime deps only: typescript/vitest are for local development.
      npm ci --omit=dev --ignore-scripts --cache $TMPDIR/.npm

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r node_modules $out/
      runHook postInstall
    '';

    # NOTE: update this hash after changing dependencies in pi/package.json.
    # Because npm ci downloads platform-specific optional binaries (e.g. darwin-arm64 vs linux-x64),
    # the outputHash differs by platform. Systems without an entry fall back to
    # lib.fakeHash: the flake still evaluates (`flake check --all-systems`), and
    # building there fails with the real hash to add.
    # Run: nix build .#pi-node-modules --rebuild 2>&1 | grep 'got:'
    # (--rebuild matters: without it, Nix reuses the old fixed-output path.)
    outputHash =
      {
        x86_64-linux = "sha256-tW48lTgvCkdg98mFgfdMmLhTzFKMcrCCeTWcSNCLYQY=";
        aarch64-darwin = "sha256-PtBks4rbsAMXeF9x2eoJJivfz/NYxPeAGC/MCLBt8pU=";
      }.${
        system
      } or pkgs.lib.fakeHash;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    dontFixup = true;
  }
