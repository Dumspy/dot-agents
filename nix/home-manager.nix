# Main bundle module: programs.dot-agents
# Auto-discovers and installs all skills, agents, commands, and extensions.
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

  # --- Auto-discover agents ---
  agentsDir = ../opencode/agents;
  agentFiles =
    if builtins.pathExists agentsDir
    then builtins.attrNames (builtins.readDir agentsDir)
    else [];
  agentNames = map (f: lib.removeSuffix ".md" f) (lib.filter (f: lib.hasSuffix ".md" f) agentFiles);

  # --- Auto-discover pi skills ---
  piSkillsDir = ../pi/skills;
  hasPiSkills = builtins.pathExists piSkillsDir;
  piSkillEntries =
    if hasPiSkills
    then builtins.readDir piSkillsDir
    else {};
  piSkillNames = lib.attrNames (lib.filterAttrs (n: v: v == "directory") piSkillEntries);

  # --- Auto-discover opencode skills ---
  opencodeSkillsDir = ../opencode/skills;
  hasOpencodeSkills = builtins.pathExists opencodeSkillsDir;
  opencodeSkillEntries =
    if hasOpencodeSkills
    then builtins.readDir opencodeSkillsDir
    else {};
  opencodeSkillNames = lib.attrNames (lib.filterAttrs (n: v: v == "directory") opencodeSkillEntries);

  # --- Auto-discover pi extensions ---
  piDir = ../pi;
  piExtensionsDir = piDir + "/extensions";
  hasPiExtensions = builtins.pathExists piExtensionsDir;
  piExtensionFiles =
    if hasPiExtensions
    then builtins.attrNames (builtins.readDir piExtensionsDir)
    else [];
  piExtensionNames = map (f: lib.removeSuffix ".ts" f) (lib.filter (f: lib.hasSuffix ".ts" f) piExtensionFiles);
  enabledPiExtensions =
    if cfg.pi.extensions == null
    then piExtensionNames
    else cfg.pi.extensions;
  missingPiExtensions = lib.filter (name: !lib.elem name piExtensionNames) enabledPiExtensions;

  # Build node_modules for Pi extensions with public npm deps
  piNodeModules = pkgs.callPackage ./pi-node-modules.nix {};

  piExtensionsBundle = pkgs.runCommand "dot-agents-pi-extensions-bundle" {preferLocalBuild = true;} ''
    mkdir -p $out
    # Copy all extension files including subdirectories (e.g. permission-system/)
    cp -rL ${piExtensionsDir}/* $out/
    # Copy public npm deps that Pi does not provide
    cp -rL ${piNodeModules}/node_modules $out/node_modules
  '';

  # Generate permissions.json from Nix config
  permissionsJson = pkgs.writeText "pi-permissions.json" (builtins.toJSON {
    rules = cfg.pi.permissions;
    masks = cfg.pi.masks;
  });

  # --- Auto-discover pi themes ---
  themesDir = ../themes/pi;
  hasThemes = builtins.pathExists themesDir;
  themeFiles =
    if hasThemes
    then builtins.attrNames (builtins.readDir themesDir)
    else [];
  themeNames = map (f: lib.removeSuffix ".json" f) (lib.filter (f: lib.hasSuffix ".json" f) themeFiles);
  enabledPiThemes =
    if cfg.pi.themes == null
    then themeNames
    else cfg.pi.themes;
  missingPiThemes = lib.filter (name: !lib.elem name themeNames) enabledPiThemes;

  # --- Auto-discover opencode commands ---
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

  # --- Bundles ---
  skillsBundle = pkgs.runCommand "dot-agents-skills-bundle" {preferLocalBuild = true;} ''
    mkdir -p $out
    ${lib.concatMapStringsSep "\n" (name: let
        pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.${name};
      in ''
        ln -s ${pkg}/share/skills/${name} $out/${name}
      '')
      allSkillNames}
  '';

  agentsBundle = pkgs.runCommand "dot-agents-agents-bundle" {preferLocalBuild = true;} ''
    mkdir -p $out
    ${lib.concatMapStringsSep "\n" (name: ''
        ln -s ${agentsDir}/${name}.md $out/${name}.md
      '')
      agentNames}
  '';

  commandsBundle = pkgs.runCommand "dot-agents-commands-bundle" {preferLocalBuild = true;} ''
    mkdir -p $out
    ${lib.concatMapStringsSep "\n" (name: ''
        ln -s ${allCommands.${name}} $out/${name}.md
      '')
      (lib.attrNames allCommands)}
  '';

  # Install strategy helper
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
in {
  imports = [./home-manager-common.nix];

  options.programs.dot-agents = {
    pi = {
      extensions = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Pi-specific extensions to install to ~/.pi/agent/extensions/.
          Set to `null` to auto-discover all extensions in pi/extensions/.
          Set to `[]` to disable extensions.
        '';
      };

      permissions = lib.mkOption {
        type = lib.types.attrsOf (lib.types.oneOf [lib.types.str (lib.types.attrsOf lib.types.str)]);
        default = {};
        description = ''
          Pi permission rules, written to ~/.pi/agent/permissions.json under the `rules` key.
          Each key is a tool name. The value is either:
          - A single permission string: "allow", "deny", "ask", or "cloak"
          - An attrset of glob patterns -> permission strings

          Example:
          {
            read = {
              "*" = "allow";
              ".env" = "cloak";
            };
            bash = {
              "*" = "ask";
              "ls*" = "allow";
            };
            webfetch = "ask";
          }
        '';
      };

      masks = lib.mkOption {
        type = lib.types.attrsOf (lib.types.attrsOf (lib.types.submodule {
          options = {
            pattern = lib.mkOption {
              type = lib.types.str;
              description = "Regex pattern to match sensitive values.";
            };
            replace = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Replacement template (e.g. \"$1\"). Uses native JS replace semantics.";
            };
            flags = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Regex flags (e.g. \"g\", \"gi\"). Defaults to \"g\".";
            };
          };
        }));
        default = {};
        description = ''
          Mask patterns for the Pi permission system, written to ~/.pi/agent/permissions.json under the `masks` key.
          Each top-level key is a tool name. Each inner key is a glob pattern matching the tool value (e.g. file path).
          Only the `read` tool supports masking in v1.

          Example:
          {
            read = {
              ".env" = { pattern = "(=).+"; replace = "$1"; };
            };
          }
        '';
      };

      themes = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Pi-specific themes to install to ~/.pi/agent/themes/.
          Set to `null` to auto-discover all themes in themes/pi/.
          Set to `[]` to disable themes.
        '';
      };
    };

    opencode = {
      commands = lib.mkOption {
        type = lib.types.attrsOf lib.types.path;
        default = {};
        description = ''
          Extra OpenCode-specific command definitions (merged with auto-discovered commands).
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
    assertions = [
      {
        assertion = missingPiExtensions == [];
        message = "dot-agents: unknown pi extension(s) requested: ${lib.concatStringsSep ", " missingPiExtensions}. Available: ${lib.concatStringsSep ", " piExtensionNames}";
      }
      {
        assertion = missingPiThemes == [];
        message = "dot-agents: unknown pi theme(s) requested: ${lib.concatStringsSep ", " missingPiThemes}. Available: ${lib.concatStringsSep ", " themeNames}";
      }
    ];

    # --- home.file ---
    home.file = lib.mkMerge [
      # Universal skills (link mode only; rsync mode uses activation)
      (lib.mkIf (cfg.structure == "link" && allSkillNames != []) (
        lib.listToAttrs (lib.concatMap (dir:
          map (name: {
            name = "${dir}/${name}";
            value.source = "${skillsBundle}/${name}";
          })
          allSkillNames)
        cfg.skillDirs)
      ))
      # Universal agents (link mode only)
      (lib.mkIf (cfg.structure == "link" && agentNames != []) (
        lib.listToAttrs (lib.concatMap (dir:
          map (name: {
            name = "${dir}/${name}.md";
            value.source = "${agentsBundle}/${name}.md";
          })
          agentNames)
        cfg.agentDirs)
      ))
      # Pi-specific skills
      (lib.mkIf (piSkillNames != []) (
        lib.listToAttrs (map (name: {
            name = ".pi/agent/skills/${name}";
            value.source = "${piSkillsDir}/${name}";
          })
          piSkillNames)
      ))
      # OpenCode-specific skills
      (lib.mkIf (opencodeSkillNames != []) (
        lib.listToAttrs (map (name: {
            name = ".config/opencode/skills/${name}";
            value.source = "${opencodeSkillsDir}/${name}";
          })
          opencodeSkillNames)
      ))
      # OpenCode commands (link mode only)
      (lib.mkIf (cfg.structure == "link" && allCommands != {}) (
        lib.listToAttrs (map (name: {
            name = ".config/opencode/commands/${name}.md";
            value.source = "${commandsBundle}/${name}.md";
          })
          (lib.attrNames allCommands))
      ))
      # Pi extensions (link mode only; rsync mode uses activation)
      (lib.mkIf (cfg.structure == "link" && enabledPiExtensions != []) {
        ".pi/agent/extensions".source = piExtensionsBundle;
      })
      # Pi permissions
      (lib.mkIf (cfg.pi.permissions != {} || cfg.pi.masks != {}) {
        ".pi/agent/permissions.json".source = permissionsJson;
      })
      # Pi themes
      (lib.mkIf (enabledPiThemes != []) (
        lib.listToAttrs (map (name: {
            name = ".pi/agent/themes/${name}.json";
            value.source = "${themesDir}/${name}.json";
          })
          enabledPiThemes)
      ))
    ];

    home.activation = lib.mkMerge [
      (lib.mkIf (cfg.structure != "link" && allSkillNames != []) (
        lib.listToAttrs (map (dir: {
            name = "install-dot-agents-skills-${lib.replaceStrings ["/"] ["-"] dir}";
            value = mkRsyncActivation skillsBundle "${config.home.homeDirectory}/${dir}" cfg.structure;
          })
          cfg.skillDirs)
      ))
      (lib.mkIf (cfg.structure != "link" && agentNames != []) (
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
      (lib.mkIf (cfg.structure != "link" && enabledPiExtensions != []) {
        "install-dot-agents-pi-extensions" =
          mkRsyncActivation piExtensionsBundle "${config.home.homeDirectory}/.pi/agent/extensions" cfg.structure;
      })
    ];
  };
}
