{
  pkgs,
  lib,
  externalSources,
}: let
  skillRegistry = import ./skills.nix {inherit externalSources;};
  piExtRegistry = import ./pi-external-extensions.nix;

  # Build a single skill derivation.
  # For simple markdown-only skills we use runCommand.
  # If a skill needs compilation (e.g. TypeScript extensions),
  # create a proper default.nix for it instead.
  mkSkillPackage = name: spec: let
    path = spec.path;
    safeName = lib.replaceStrings ["/"] ["-"] name;
  in
    pkgs.runCommand "skill-${safeName}" {
      preferLocalBuild = true;
      meta = {
        description = "Agent skill: ${name}";
      };
    } ''
      mkdir -p $out/share/skills
      cp -r ${path} $out/share/skills/${name}
    '';

  # Build a single external Pi npm package.
  # The lockfile lives at nix/external-locks/<package>-<version>.package-lock.json
  # and pins transitive deps so `npm ci` is deterministic.
  mkPiNpmPackage = name: spec:
    pkgs.callPackage ./build-pi-npm-package.nix {
      packageName = spec.package;
      version = spec.version;
      hash = spec.hash;
      npmDepsHash = spec.npmDepsHash;
      packageLock = ./external-locks + "/${spec.package}-${spec.version}.package-lock.json";
      metaDescription = spec.description or spec.package;
    };

  # Fetch a single-file external Pi extension (`type = "file"`).
  # The derivation output *is* the extension file, deployed verbatim to
  # ~/.pi/agent/extensions/<filename> by home-manager.nix.
  mkPiFileExtension = name: spec:
    pkgs.fetchurl {
      url = spec.url;
      hash = spec.hash;
    };

  skillPackages = lib.mapAttrs mkSkillPackage skillRegistry;

  npmExts = lib.filterAttrs (_: spec: spec.type == "npm") piExtRegistry;
  extPackages = lib.mapAttrs mkPiNpmPackage npmExts;

  fileExts = lib.filterAttrs (_: spec: spec.type == "file") piExtRegistry;
  filePackages = lib.mapAttrs mkPiFileExtension fileExts;

  allPackages = skillPackages // extPackages // filePackages;

  collisions = lib.intersectLists (builtins.attrNames skillPackages) (builtins.attrNames extPackages);
  fileNameCollisions = lib.filter (name: lib.elem name (builtins.attrNames skillPackages)) (builtins.attrNames filePackages);
in
  assert lib.assertMsg (collisions == [])
  "packages.nix: skill and extension names collide: ${lib.concatStringsSep ", " collisions}. Rename one.";
  assert lib.assertMsg (fileNameCollisions == [])
  "packages.nix: file extension and skill names collide: ${lib.concatStringsSep ", " fileNameCollisions}. Rename one."; allPackages
