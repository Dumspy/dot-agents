{
  pkgs,
  lib,
  externalSources,
}: let
  registry = import ./skills.nix {inherit externalSources;};

  # Build a single skill derivation
  mkSkillPackage = name: spec: let
    path =
      if spec.type == "local"
      then spec.path
      else spec.path;

    safeName = lib.replaceStrings ["/"] ["-"] name;
  in
    pkgs.runCommand "skill-${safeName}" {preferLocalBuild = true;} ''
      mkdir -p $out/share/skills
      cp -r ${path} $out/share/skills/${name}
    '';
in
  # Build all skills as named packages
  lib.mapAttrs mkSkillPackage registry
