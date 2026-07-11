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
      npm ci --ignore-scripts --cache $TMPDIR/.npm

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
    # the outputHash differs by platform. Add a new entry when building on a new system.
    # Run: nix build --impure --expr 'let pkgs = import <nixpkgs> {}; in pkgs.callPackage ./nix/pi-node-modules.nix {}' --rebuild 2>&1 | grep 'got:'
    outputHash =
      {
        x86_64-linux = "sha256-mETdZwOZoMtTF/lkuj3KO5gn+OBesarurVbdHdUOju4=";
        aarch64-darwin = "sha256-ewRP/st5vixYf2ShHbK/gXoJakZvh7UhzRt9+CV7+Cw=";
        aarch64-linux = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        x86_64-darwin = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      }.${
        system
      } or (throw "dot-agents pi-node-modules: no outputHash for platform ${system}. Run the build to get the 'got:' hash and add it here.");
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    dontFixup = true;
  }
