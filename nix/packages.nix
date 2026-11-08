{
  pkgs,
  lib,
  externalSources,
}: let
  skillRegistry = import ./skills.nix {inherit externalSources;};
  piExtRegistry = import ./pi-external-extensions.nix;

  # Build a single skill derivation (markdown-only, so a plain copy).
  mkSkillPackage = name: spec: let
    safeName = lib.replaceStrings ["/"] ["-"] name;
  in
    pkgs.runCommand "skill-${safeName}" {
      preferLocalBuild = true;
      meta = {
        description = "Agent skill: ${name}";
      };
    } ''
      mkdir -p $out/share/skills
      cp -r ${spec.path} $out/share/skills/${name}
    '';

  # Fetch a single-file external Pi extension. The derivation output *is*
  # the extension file, deployed verbatim to
  # ~/.pi/agent/extensions/<filename> by home-manager.nix.
  mkPiFileExtension = name: spec:
    pkgs.fetchurl {
      url = spec.url;
      hash = spec.hash;
    };

  skillPackages = lib.mapAttrs mkSkillPackage skillRegistry;
  extPackages = lib.mapAttrs mkPiFileExtension piExtRegistry;

  collisions = lib.intersectLists (builtins.attrNames skillPackages) (builtins.attrNames extPackages);
in
  assert lib.assertMsg (collisions == [])
  "packages.nix: skill and extension names collide: ${lib.concatStringsSep ", " collisions}. Rename one.";
    skillPackages // extPackages
