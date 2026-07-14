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
      lockfile = ./locks/${spec.package}-${spec.version}.package-lock.json;
    };

  skillPackages = lib.mapAttrs mkSkillPackage skillRegistry;

  # Only build npm-type external extensions (skip non-npm in future)
  npmExts = lib.filterAttrs (_: spec: spec.type == "npm") piExtRegistry;
  extPackages = lib.mapAttrs mkPiNpmPackage npmExts;
in
  # Merge skill and extension packages into one attrset
  skillPackages // extPackages
