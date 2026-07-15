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
  mkPiNpmPackage = name: spec:
    pkgs.callPackage ./build-pi-npm-package.nix {
      packageName = spec.package;
      version = spec.version;
      hash = spec.hash;
      npmDepsHash = spec.npmDepsHash;
      metaDescription = spec.description or spec.package;
    };

  skillPackages = lib.mapAttrs mkSkillPackage skillRegistry;

  npmExts = lib.filterAttrs (_: spec: spec.type == "npm") piExtRegistry;
  extPackages = lib.mapAttrs mkPiNpmPackage npmExts;

  collisions = lib.intersectLists (builtins.attrNames skillPackages) (builtins.attrNames extPackages);
in
  assert lib.assertMsg (collisions == [])
  "packages.nix: skill and extension names collide: ${lib.concatStringsSep ", " collisions}. Rename one.";
    skillPackages // extPackages
