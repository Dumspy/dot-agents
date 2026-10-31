# Shared options for the programs.dot-agents Home Manager module.
{lib, ...}: {
  options.programs.dot-agents = {
    enable = lib.mkEnableOption "dot-agents universal agent configuration";

    skillDirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        ".agents/skills"
      ];
      example = [
        ".agents/skills"
        ".pi/agent/skills"
        ".config/opencode/skills"
      ];
      description = ''
        Directories (relative to `$HOME`) into which each enabled skill's
        definition is symlinked as `<dir>/<skill>/`. One entry per agent
        harness that should discover the skills.

        Default is `.agents/skills/`, which Pi and OpenCode discover.
        Grok Bot reads `skills/` and `grokbot/skills/` from the Git
        repository and has no install directory in this module.
      '';
    };

    agentDirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        ".config/opencode/agents"
      ];
      description = ''
        Directories (relative to `$HOME`) into which each enabled agent's
        definition is symlinked.
      '';
    };
  };
}
