# Per-skill flake.homeModules.<name>
# Each module enables exactly one skill and symlinks it into skillDirs.
{
  self,
  lib,
}: let
  # We only need the skill names here; the actual paths are resolved at build time
  # via self.packages. To avoid needing externalSources, we extract names from
  # skills.nix by providing dummy inputs (we never evaluate the path values).
  dummyInputs = {
    vercel-agent-skills = ./.;
    expo-agent-skills = ./.;
    agent-browser = ./.;
    anthropics-agent-skills = ./.;
    dex-agent-skills = ./.;
    sentry-skills = ./.;
  };
  registry = import ./skills.nix {externalSources = dummyInputs;};

  mkSkillModule = name: _spec: {
    pkgs,
    config,
    ...
  }: let
    pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.${name};
    skillDir = "${pkg}/share/skills/${name}";
  in {
    key = "dot-agents/skill/${name}";
    imports = [./home-manager-common.nix];

    config = lib.mkIf config.programs.dot-agents.enable {
      home.file = lib.listToAttrs (
        map (
          dir: lib.nameValuePair "${dir}/${name}" {source = skillDir;}
        )
        config.programs.dot-agents.skillDirs
      );
    };
  };
in
  builtins.mapAttrs mkSkillModule registry
