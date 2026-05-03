{
  pkgs,
  lib,
  externalSources,
}: let
  registry = import ./skills.nix {inherit externalSources;};

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
in
  # Build all skills as named packages
  lib.mapAttrs mkSkillPackage registry
