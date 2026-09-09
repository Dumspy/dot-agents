# Build an npm package for Pi's external extension loader.
#
# Fetches the tarball, runs `npm ci --omit=dev` against a vendored lockfile,
# and produces a fixed-output derivation. The entire installed tree
# (package + node_modules) is hashed via npmDepsHash.
#
# The lockfile (nix/external-locks/<package>-<version>.package-lock.json) pins
# transitive deps, so the hash is stable until the version or lockfile changes.
# Regenerate the lockfile when bumping `version`:
#
#   TMP=$(mktemp -d) && \
#     curl -sL https://registry.npmjs.org/<pkg>/-/<pkg>-<ver>.tgz -o $TMP/pkg.tgz && \
#     mkdir -p $TMP/pkg && tar xzf $TMP/pkg.tgz --strip-components=1 -C $TMP/pkg && \
#     (cd $TMP/pkg && npm install --package-lock-only --ignore-scripts) && \
#     cp $TMP/pkg/package-lock.json nix/external-locks/<pkg>-<ver>.package-lock.json
#
# Usage (in packages.nix):
#   buildPiNpmPackage {
#     inherit (pkgs) stdenvNoCC nodejs cacert fetchurl;
#     packageName = "pi-mcp-adapter";
#     version = "2.11.0";
#     hash = "sha256-...";
#     npmDepsHash = "sha256-...";
#     packageLock = ./external-locks/pi-mcp-adapter-2.11.0.package-lock.json;
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
  packageLock,
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
      # Vendored lockfile pins transitive deps (see header comment).
      # `npm ci` fails loudly if package.json and the lock are out of sync,
      # which is what we want — no silent semver drift.
      cp ${packageLock} ./package-lock.json
      npm ci --omit=dev --ignore-scripts --cache $TMPDIR/.npm

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
