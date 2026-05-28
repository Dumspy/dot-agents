{pkgs}:
pkgs.stdenvNoCC.mkDerivation {
  name = "dot-agents-pi-node-modules";

  src = pkgs.runCommand "pi-extensions-runtime-source" {} ''
    mkdir -p $out
    cat > $out/package.json << 'JSON'
    {
      "name": "pi-extensions-runtime",
      "version": "1.0.0",
      "dependencies": {
        "picomatch": "4.0.4",
        "html-to-text": "9.0.5",
        "linkedom": "0.18.12",
        "turndown": "7.2.4",
        "turndown-plugin-gfm": "1.0.2"
      }
    }
    JSON
    cp ${../pi/package-lock.runtime.json} $out/package-lock.json
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

  outputHash = "sha256-GuuJhbzrc7jA/+tiBxO84wh486/jK4YrbpGK9abWnxc=";
  outputHashAlgo = "sha256";
  outputHashMode = "recursive";
  dontFixup = true;
}
