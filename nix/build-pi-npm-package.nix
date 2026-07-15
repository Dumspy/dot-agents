# Builder for external Pi extensions sourced from npm.
#
# Pi discovers npm packages listed in settings.json → packages by looking
# for them in ~/.pi/agent/npm/<name>/ (global) or .pi/npm/<name>/ (project).
# Each package directory must contain the package tarball contents with
# node_modules/ installed.
#
# This builder fetches an npm package tarball, runs `npm install --omit=dev`,
# and produces a fixed-output derivation suitable for linking into Pi's npm
# directory. No lockfile is needed — the entire installed output is hashed
# via `npmDepsHash` (fixed-output derivation).
#
# Trade-off: `npm install` resolves semver ranges against the live registry,
# so if a transitive dep publishes a new patch the `npmDepsHash` will shift.
# CI catches this immediately and it's a one-line fix (update the hash).
#
# Usage (in packages.nix):
#   buildPiNpmPackage {
#     inherit (pkgs) stdenvNoCC nodejs cacert fetchurl;
#     packageName = "pi-mcp-adapter";
#     version = "2.11.0";
#     hash = "sha256-...";           # tarball hash (SRI)
#     npmDepsHash = "sha256-...";    # installed output hash (SRI, recursive)
#   }
#
# To add a new extension:
#   1. nix-prefetch-url https://registry.npmjs.org/<name>/-/<name>-<ver>.tgz
#   2. Set npmDepsHash = lib.fakeSha256 in the registry entry, build, and
#      copy the 'got:' hash from the error into npmDepsHash.
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

    # Fixed-output: hash the entire installed output (the pkg dir + node_modules).
    # Set npmDepsHash to lib.fakeSha256 first, build, then use the 'got:'
    # value from the error message.
    outputHash = npmDepsHash;
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
    dontFixup = true;
  }
