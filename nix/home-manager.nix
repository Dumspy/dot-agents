# Main bundle module: programs.dot-agents
# Provides a single option to enable skills/agents and install them to configured directories.
{
  self,
  externalSources,
}: {
  config,
  pkgs,
  lib,
  ...
}: let
  cfg = config.programs.dot-agents;

  registry = import ./skills.nix {inherit externalSources;};
  allSkillNames = builtins.attrNames registry;

  # Available agents (local .md files in ../agents/)
  agentsDir = ../agents;
  agentFiles =
    if builtins.pathExists agentsDir
    then builtins.attrNames (builtins.readDir agentsDir)
    else [];
  agentNames = map (f: lib.removeSuffix ".md" f) (lib.filter (f: lib.hasSuffix ".md" f) agentFiles);

  # Determine enabled skills
  enabledSkillNames =
    if cfg.enableAllSkills
    then allSkillNames
    else cfg.skills;

  # Determine enabled agents
  enabledAgentNames =
    if cfg.enableAllAgents
    then agentNames
    else cfg.agents;

  # Validate that requested skills exist
  missingSkills = lib.filter (name: !builtins.hasAttr name registry) enabledSkillNames;
  _assertSkills =
    lib.assertMsg (missingSkills == [])
    "dot-agents: unknown skill(s) requested: ${lib.concatStringsSep ", " missingSkills}. Available: ${lib.concatStringsSep ", " allSkillNames}";

  # Validate that requested agents exist
  missingAgents = lib.filter (name: !lib.elem name agentNames) enabledAgentNames;
  _assertAgents =
    lib.assertMsg (missingAgents == [])
    "dot-agents: unknown agent(s) requested: ${lib.concatStringsSep ", " missingAgents}. Available: ${lib.concatStringsSep ", " agentNames}";

  # Validate that requested pi skills exist
  missingPiSkills = lib.filter (name: !builtins.hasAttr name registry) cfg.pi.skills;
  _assertPiSkills =
    lib.assertMsg (missingPiSkills == [])
    "dot-agents: unknown skill(s) in pi.skills: ${lib.concatStringsSep ", " missingPiSkills}. Available: ${lib.concatStringsSep ", " allSkillNames}";

  # Validate that requested opencode skills exist
  missingOpencodeSkills = lib.filter (name: !builtins.hasAttr name registry) cfg.opencode.skills;
  _assertOpencodeSkills =
    lib.assertMsg (missingOpencodeSkills == [])
    "dot-agents: unknown skill(s) in opencode.skills: ${lib.concatStringsSep ", " missingOpencodeSkills}. Available: ${lib.concatStringsSep ", " allSkillNames}";

  # Build a derivation containing all enabled skills
  skillsBundle = pkgs.runCommand "dot-agents-skills-bundle" {preferLocalBuild = true;} ''
    mkdir -p $out
    ${lib.concatMapStringsSep "\n" (name: let
        pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.${name};
      in ''
        ln -s ${pkg}/share/skills/${name} $out/${name}
      '')
      enabledSkillNames}
  '';

  # Build a derivation containing all enabled agents
  agentsBundle = pkgs.runCommand "dot-agents-agents-bundle" {preferLocalBuild = true;} ''
    mkdir -p $out
    ${lib.concatMapStringsSep "\n" (name: ''
        ln -s ${agentsDir}/${name}.md $out/${name}.md
      '')
      enabledAgentNames}
  '';

  # Build a derivation containing all enabled commands
  commandsBundle = pkgs.runCommand "dot-agents-commands-bundle" {preferLocalBuild = true;} ''
    mkdir -p $out
    ${lib.concatMapStringsSep "\n" (name: ''
        ln -s ${allCommands.${name}} $out/${name}.md
      '')
      (lib.attrNames allCommands)}
  '';

  # Auto-discover opencode commands
  commandsDir = ../opencode/commands;
  hasCommands = builtins.pathExists commandsDir;
  commandFiles =
    if hasCommands
    then builtins.attrNames (builtins.readDir commandsDir)
    else [];
  commandNames = map (f: lib.removeSuffix ".md" f) (lib.filter (f: lib.hasSuffix ".md" f) commandFiles);
  discoveredCommands = lib.listToAttrs (
    map (name: {
      inherit name;
      value = commandsDir + "/${name}.md";
    })
    commandNames
  );

  # Merge user commands with discovered commands (user takes precedence)
  allCommands = discoveredCommands // cfg.opencode.commands;

  # Install strategy helpers
  mkRsyncActivation = bundle: destPath: structure: let
    rsyncFlags =
      if structure == "symlink-tree"
      then "-a --delete"
      else "-aL --delete";
  in
    lib.hm.dag.entryAfter ["writeBoundary"] ''
      mkdir -p "${destPath}"
      ${pkgs.rsync}/bin/rsync ${rsyncFlags} "${bundle}/" "${destPath}/"
    '';

  # Generate home.file entries for link mode
  mkSkillFiles = destBase:
    lib.listToAttrs (map (name: {
        name = "${destBase}/${name}";
        value.source = "${skillsBundle}/${name}";
      })
      enabledSkillNames);

  mkAgentFiles = destBase:
    lib.listToAttrs (map (name: {
        name = "${destBase}/${name}.md";
        value.source = "${agentsBundle}/${name}.md";
      })
      enabledAgentNames);
in {
  imports = [./home-manager-common.nix];

  options.programs.dot-agents = {
    skills = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "List of skill names to enable.";
    };

    enableAllSkills = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Enable all available skills.";
    };

    agents = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "List of agent names to enable.";
    };

    enableAllAgents = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Enable all available agents.";
    };

    pi = {
      skills = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        description = "Pi-specific skills to install to ~/.pi/agent/skills/.";
      };
    };

    opencode = {
      skills = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        description = "OpenCode-specific skills to install to ~/.config/opencode/skills/.";
      };

      commands = lib.mkOption {
        type = lib.types.attrsOf lib.types.path;
        default = {};
        description = ''
          OpenCode-specific command definitions.
          Each entry is a name -> path mapping for opencode commands.
        '';
      };
    };

    structure = lib.mkOption {
      type = lib.types.enum ["link" "symlink-tree" "copy-tree"];
      default = "symlink-tree";
      description = ''
        How to install skills/agents:
        - link: individual home.file symlinks
        - symlink-tree: rsync preserving symlinks
        - copy-tree: rsync dereferencing symlinks
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # --- home.file ---
    home.file = lib.mkMerge [
      # Universal skills (link mode only; rsync mode uses activation)
      (lib.mkIf (cfg.structure == "link" && enabledSkillNames != []) (
        lib.listToAttrs (lib.concatMap (dir:
          map (name: {
            name = "${dir}/${name}";
            value.source = "${skillsBundle}/${name}";
          })
          enabledSkillNames)
        cfg.skillDirs)
      ))
      # Universal agents (link mode only)
      (lib.mkIf (cfg.structure == "link" && enabledAgentNames != []) (
        lib.listToAttrs (lib.concatMap (dir:
          map (name: {
            name = "${dir}/${name}.md";
            value.source = "${agentsBundle}/${name}.md";
          })
          enabledAgentNames)
        cfg.agentDirs)
      ))
      # Pi-specific skills
      (lib.mkIf (cfg.pi.skills != []) (
        lib.listToAttrs (map (name: let
            pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.${name};
          in {
            name = ".pi/agent/skills/${name}";
            value.source = "${pkg}/share/skills/${name}";
          })
          cfg.pi.skills)
      ))
      # OpenCode-specific skills
      (lib.mkIf (cfg.opencode.skills != []) (
        lib.listToAttrs (map (name: let
            pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.${name};
          in {
            name = ".config/opencode/skills/${name}";
            value.source = "${pkg}/share/skills/${name}";
          })
          cfg.opencode.skills)
      ))
      # OpenCode commands (link mode only)
      (lib.mkIf (cfg.structure == "link" && allCommands != {}) (
        lib.listToAttrs (map (name: {
            name = ".config/opencode/commands/${name}.md";
            value.source = "${commandsBundle}/${name}.md";
          })
          (lib.attrNames allCommands))
      ))
    ];

    home.activation = lib.mkMerge [
      (lib.mkIf (cfg.structure != "link" && enabledSkillNames != []) (
        lib.listToAttrs (map (dir: {
            name = "install-dot-agents-skills-${lib.replaceStrings ["/"] ["-"] dir}";
            value = mkRsyncActivation skillsBundle "${config.home.homeDirectory}/${dir}" cfg.structure;
          })
          cfg.skillDirs)
      ))
      (lib.mkIf (cfg.structure != "link" && enabledAgentNames != []) (
        lib.listToAttrs (map (dir: {
            name = "install-dot-agents-agents-${lib.replaceStrings ["/"] ["-"] dir}";
            value = mkRsyncActivation agentsBundle "${config.home.homeDirectory}/${dir}" cfg.structure;
          })
          cfg.agentDirs)
      ))
      (lib.mkIf (cfg.structure != "link" && allCommands != {}) {
        "install-dot-agents-commands" =
          mkRsyncActivation commandsBundle "${config.home.homeDirectory}/.config/opencode/commands" cfg.structure;
      })
    ];
  };
}
