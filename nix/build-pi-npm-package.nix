# Builder for external Pi extensions sourced from npm.
#
# Pi discovers npm packages listed in settings.json → packages by looking
# for them in ~/.pi/agent/npm/<name>/ (global) or .pi/npm/<name>/ (project).
# Each package directory must contain the package tarball contents with
# node_modules/ installed (npm install has been run).
#
# This builder fetches an npm package tarball, runs npm install, and
# produces a derivation suitable for linking into Pi's npm directory.
#
# Usage (in packages.nix or similar):
#   buildPiNpmPackage {
#     inherit (pkgs) stdenvNoCC nodejs cacert fetchurl;
#     packageName = "pi-mcp-adapter";
#     version = "2.11.0";
#     hash = "sha256-...";  # tarball hash (SRI)
#     npmDepsHash = "sha256-...";  # node_modules hash (SRI, fixed-output)
#   }
#
# To get the hashes:
#   1. tarball hash: nix-prefetch-url https://registry.npmjs.org/<name>/-/<name>-<ver>.tgz
#   2. npmDepsHash: build once with empty hash, use the 'got:' from the error
{
  stdenvNoCC,
  nodejs,
  cacert,
  fetchurl,
  packageName,
  version,
  hash,
  npmDepsHash,
}: let
  tarball = fetchurl {
    url = "https://registry.npmjs.org/${packageName}/-/${packageName}-${version}.tgz";
    inherit hash;
  };
in
  stdenvNoCC.mkDerivation {
    name = "${packageName}-${version}";

    nativeBuildInputs = [nodejs cacert];

    dontUnpack = true;

    buildPhase = ''
      runHook preBuild

      export HOME=$TMPDIR
      export npm_config_cache=$TMPDIR/.npm
      export NODE_EXTRA_CA_CERTS="${cacert}/etc/ssl/certs/ca-bundle.crt"

      mkdir pkg
      tar xzf ${tarball} --strip-components=1 -C pkg
      cd pkg
      npm install --omit=dev --ignore-scripts --cache $TMPDIR/.npm

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -r . $out/
      runHook postInstall
    '';

    # Fixed-output: npm install needs network, so we use a content hash.
    # Set this to empty string first, build, then use the 'got:' value
    # from the error message.
    outputHash = npmDepsHash;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    dontFixup = true;
  }
