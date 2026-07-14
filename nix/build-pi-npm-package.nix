# Builder for external Pi extensions sourced from npm.
#
# Pi discovers npm packages listed in settings.json → packages by looking
# for them in ~/.pi/agent/npm/<name>/ (global) or .pi/npm/<name>/ (project).
# Each package directory must contain the package tarball contents with
# node_modules/ installed.
#
# This builder fetches an npm package tarball, runs `npm ci` against a
# vendored package-lock.json, and produces a derivation suitable for
# linking into Pi's npm directory.
#
# Why `npm ci` with a vendored lockfile (and not `npm install`):
# `npm install` resolves semver ranges against the live registry, so
# unpinned transitive deps can shift between builds (failing the
# fixed-output hash). `npm ci` is fully deterministic given a lockfile.
#
# Usage (in packages.nix):
#   buildPiNpmPackage {
#     inherit (pkgs) stdenvNoCC nodejs cacert fetchurl;
#     packageName = "pi-mcp-adapter";
#     version = "2.11.0";
#     hash = "sha256-...";           # tarball hash (SRI)
#     npmDepsHash = "sha256-...";    # node_modules hash (SRI, recursive)
#     lockfile = ./locks/<name>-<version>.package-lock.json;
#   }
#
# To add a new extension:
#   1. nix-prefetch-url https://registry.npmjs.org/<name>/-/<name>-<ver>.tgz
#   2. In a scratch dir: npm pack <name>@<ver> && tar xzf <tgz> --strip-components=1
#      && npm install --omit=dev --ignore-scripts --package-lock-only
#      Commit the generated package-lock.json as
#      nix/locks/<name>-<version>.package-lock.json.
#   3. Set npmDepsHash = lib.fakeSha256 in the registry entry, build, and
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
  lockfile,
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
      # Replace the (empty) lockfile in the tarball with the vendored one.
      # This is what makes the install reproducible: `npm ci` requires
      # an exact lockfile and refuses to mutate it.
      cp ${lockfile} pkg/package-lock.json
      cd pkg
      npm ci --omit=dev --ignore-scripts --cache $TMPDIR/.npm

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
