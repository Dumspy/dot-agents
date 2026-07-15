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

  piExternalExtRegistry = import ./pi-external-extensions.nix;

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
  piExtensionEntries =
    if hasPiExtensions
    then builtins.readDir piExtensionsDir
    else {};
  piExtensionFiles = builtins.attrNames piExtensionEntries;
  piExtensionNames = let
    fileNames = map (f: lib.removeSuffix ".ts" f) (lib.filter (f: lib.hasSuffix ".ts" f) piExtensionFiles);
    dirNames = lib.attrNames (lib.filterAttrs (n: v: v == "directory") piExtensionEntries);
  in
    fileNames ++ dirNames;
  enabledPiExtensions =
    if cfg.pi.extensions == null
    then piExtensionNames
    else cfg.pi.extensions;
  missingPiExtensions = lib.filter (name: !lib.elem name piExtensionNames) enabledPiExtensions;

  # Build node_modules for Pi extensions with public npm deps
  piNodeModules = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-node-modules;

  # --- External Pi extensions (npm) ---
  allExternalExtNames = builtins.attrNames piExternalExtRegistry;
  enabledExternalExts =
    if cfg.pi.externalExtensions == null
    then allExternalExtNames
    else cfg.pi.externalExtensions;
  missingExternalExts = lib.filter (name: !lib.elem name allExternalExtNames) enabledExternalExts;

  externalExtPkgs = lib.genAttrs enabledExternalExts (
    name: self.packages.${pkgs.stdenv.hostPlatform.system}.${name}
  );

  externalExtSettingsPackages = map (name: piExternalExtRegistry.${name}.package) enabledExternalExts;

  externalExtSettingsJson = builtins.toJSON {
    packages = externalExtSettingsPackages;
  };

  # All registry package names (for cleanup of previously-enabled packages)
  allRegistryPackages = map (name: piExternalExtRegistry.${name}.package) allExternalExtNames;
  allRegistryPackagesJson = builtins.toJSON allRegistryPackages;

  piExtensionsBundle =
    pkgs.runCommand "dot-agents-pi-extensions-bundle" {
      preferLocalBuild = true;
      nativeBuildInputs = [pkgs.rsync];
    } ''
      mkdir -p $out
      # Copy extension files excluding tests and their dev-only deps
      rsync -aL \
        --exclude='*.test.ts' --exclude='*.test.js' \
        --exclude='*.spec.ts' --exclude='*.spec.js' \
        --exclude='*.test.tsx' --exclude='*.spec.tsx' \
        --exclude='test/' --exclude='__tests__/' \
        ${piExtensionsDir}/ $out/
      chmod -R u+w $out
    '';

  # Generate permissions.json from Nix config
  permissionsJson = pkgs.writeText "pi-permissions.json" (builtins.toJSON {
    rules = cfg.pi.permissions;
    masks = cfg.pi.masks;
  });

  # Generate keybindings.json from Nix config
  keybindingsJson = pkgs.writeText "pi-keybindings.json" (builtins.toJSON cfg.pi.keybindings);

  # --- Auto-discover pi themes ---
  piThemesDir = ../pi/themes;
  hasPiThemes = builtins.pathExists piThemesDir;
  piThemeFiles =
    if hasPiThemes
    then builtins.attrNames (builtins.readDir piThemesDir)
    else [];
  piThemeNames = map (f: lib.removeSuffix ".json" f) (lib.filter (f: lib.hasSuffix ".json" f) piThemeFiles);
  enabledPiThemes =
    if cfg.pi.themes == null
    then piThemeNames
    else cfg.pi.themes;
  missingPiThemes = lib.filter (name: !lib.elem name piThemeNames) enabledPiThemes;

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
      chmod -R u+w "${destPath}"
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

      externalExtensions = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = [];
        description = ''
          External Pi extensions to install from npm, deployed to
          ~/.pi/agent/npm/<name>/ and registered in settings.json.
          Set to `null` to auto-discover all from the registry.
          Set to `[]` to disable external extensions (default).
        '';
      };

      themes = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        description = ''
          Pi-specific themes to install to ~/.pi/agent/themes/.
          Set to `null` to auto-discover all themes in pi/themes/.
          Set to `[]` to disable themes.
        '';
      };

      keybindings = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = {};
        description = ''
          Pi keybinding overrides, written to ~/.pi/agent/keybindings.json.
          Each key is a keybinding action id, each value is the key or keys
          (space-separated for multiple). Use this to override defaults
          per-host (e.g. remap pasteImage on WSL where Ctrl+V is intercepted).

          Example:
          {
            "app.clipboard.pasteImage" = "alt+v";
            "tui.input.newLine" = "ctrl+j";
          }
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
        message = "dot-agents: unknown pi theme(s) requested: ${lib.concatStringsSep ", " missingPiThemes}. Available: ${lib.concatStringsSep ", " piThemeNames}";
      }
      {
        assertion = missingExternalExts == [];
        message = "dot-agents: unknown external pi extension(s) requested: ${lib.concatStringsSep ", " missingExternalExts}. Available: ${lib.concatStringsSep ", " allExternalExtNames}";
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
      # Pi extension runtime dependencies (deploy if any local or external extensions enabled)
      (lib.mkIf (enabledPiExtensions != [] || enabledExternalExts != []) {
        ".pi/agent/package.json".source = piDir + "/package.json";
        ".pi/agent/node_modules".source = piNodeModules + "/node_modules";
      })
      # Pi permissions
      (lib.mkIf (cfg.pi.permissions != {} || cfg.pi.masks != {}) {
        ".pi/agent/permissions.json".source = permissionsJson;
      })
      # Pi keybindings
      (lib.mkIf (cfg.pi.keybindings != {}) {
        ".pi/agent/keybindings.json".source = keybindingsJson;
      })
      # Pi themes
      (lib.mkIf (enabledPiThemes != []) (
        lib.listToAttrs (map (name: {
            name = ".pi/agent/themes/${name}.json";
            value.source = "${piThemesDir}/${name}.json";
          })
          enabledPiThemes)
      ))
      (lib.mkIf (enabledExternalExts != []) (
        lib.listToAttrs (map (name: {
            name = ".pi/agent/npm/${piExternalExtRegistry.${name}.package}";
            value.source = "${externalExtPkgs.${name}}";
          })
          enabledExternalExts)
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
      # Sync registry-managed packages into Pi's settings.json.
      # Adds enabled packages, removes disabled ones, preserves user-installed packages.
      (lib.mkIf (enabledExternalExts != [] || cfg.pi.externalExtensions != null) {
        "install-dot-agents-pi-external-extensions-settings" = lib.hm.dag.entryAfter ["writeBoundary"] ''
          export PATH="${pkgs.jq}/bin:$PATH"
          SETTINGS="${config.home.homeDirectory}/.pi/agent/settings.json"
          REGISTRY_PACKAGES='${allRegistryPackagesJson}'
          OUR_PACKAGES='${externalExtSettingsJson}'

          mkdir -p "$(dirname "$SETTINGS")"

          if [ -f "$SETTINGS" ]; then
            jq --argjson registry "$REGISTRY_PACKAGES" --argjson ours "$OUR_PACKAGES" \
              '. as $s |
               $s + {
                 packages: (
                   (($s.packages // []) | map(select(. as $pkg | $registry | index($pkg) | not))) +
                   $ours.packages
                 ) | unique
               }' \
              "$SETTINGS" > "$SETTINGS.tmp"
            mv "$SETTINGS.tmp" "$SETTINGS"
          else
            echo "$OUR_PACKAGES" > "$SETTINGS"
          fi

          chmod 644 "$SETTINGS"
        '';
      })
    ];
  };
}
