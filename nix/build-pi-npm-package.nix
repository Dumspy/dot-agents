# Build an npm package for Pi's external extension loader.
#
# Fetches the tarball, runs `npm install --omit=dev`, and produces a
# fixed-output derivation. The entire installed tree (package + node_modules)
# is hashed via npmDepsHash, so no lockfile is needed.
#
# Trade-off: npm resolves semver ranges live, so transitive dep patches can
# shift the hash. CI catches this; fix is a one-line hash update.
#
# Usage (in packages.nix):
#   buildPiNpmPackage {
#     inherit (pkgs) stdenvNoCC nodejs cacert fetchurl;
#     packageName = "pi-mcp-adapter";
#     version = "2.11.0";
#     hash = "sha256-...";
#     npmDepsHash = "sha256-...";
#   }
#
# To get hashes for a new package, see README.md → "Adding a new external extension".
{
  stdenvNoCC,
  nodejs,
  cacert,
  fetchurl,
  packageName,
  version,
  hash,
  npmDepsHash,
  metaDescription ? packageName,
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

    outputHash = npmDepsHash;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";

    # Pure JS packages — no ELF binaries or shebangs to patch.
    dontFixup = true;

    meta = {
      description = metaDescription;
    };
  }
