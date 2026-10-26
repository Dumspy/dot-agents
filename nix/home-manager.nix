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
  extraPiExtensionNames = lib.attrNames cfg.pi.extraExtensions;
  overlayExtensionSources = cfg.pi.extraExtensions // fileExtOverlaySources;
  overlayExtensionNames = builtins.attrNames overlayExtensionSources;
  hasEnabledPiExtensions = enabledPiExtensions != [] || overlayExtensionNames != [];

  # Build node_modules for Pi extensions with public npm deps
  piNodeModules = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-node-modules;

  # --- External Pi extensions (npm + file) ---
  allExternalExtNames = builtins.attrNames piExternalExtRegistry;
  enabledExternalExts =
    if cfg.pi.externalExtensions == null
    then allExternalExtNames
    else cfg.pi.externalExtensions;
  missingExternalExts = lib.filter (name: !lib.elem name allExternalExtNames) enabledExternalExts;

  isFileExt = name: (piExternalExtRegistry.${name}.type or "npm") == "file";
  enabledFileExts = lib.filter isFileExt enabledExternalExts;
  enabledNpmExts = lib.filter (name: !(isFileExt name)) enabledExternalExts;

  externalExtPkgs = lib.genAttrs enabledExternalExts (
    name: self.packages.${pkgs.stdenv.hostPlatform.system}.${name}
  );

  # File-type extensions deploy as plain files into the extensions bundle,
  # alongside extraExtensions. Filenames must not collide with those.
  fileExtOverlaySources = lib.listToAttrs (map (name: {
      name = piExternalExtRegistry.${name}.filename;
      value = externalExtPkgs.${name};
    })
    enabledFileExts);
  overlappingOverlayNames = lib.intersectLists (builtins.attrNames fileExtOverlaySources) extraPiExtensionNames;

  # The packages array we contribute to Pi's settings.json (npm only, with npm: prefix)
  externalExtSettingsPackages = map (name: "npm:${piExternalExtRegistry.${name}.package}") enabledNpmExts;

  externalExtSettingsJson = builtins.toJSON {
    packages = externalExtSettingsPackages;
  };

  # Bare npm package names (no `npm:` prefix, no `@version` suffix) currently
  # enabled. settings.json `packages` is managed authoritatively from this
  # list, so removing an entry here (or from the registry) removes it from
  # the machine on the next rebuild — no tombstone list needed.
  enabledNpmBare = map (name: piExternalExtRegistry.${name}.package) enabledNpmExts;
  enabledNpmBareJson = builtins.toJSON (lib.unique enabledNpmBare);

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
      # Overlay declarative extension sources (extraExtensions + file-type
      # external extensions) after the auto-discovered bundle.
      ${lib.concatMapStringsSep "\n" (name: ''
          install -Dm644 ${overlayExtensionSources.${name}} "$out/${name}"
        '')
        overlayExtensionNames}
    '';

  # Generate judge.json (static judge-gate config) from Nix config
  judgeJson = pkgs.writeText "pi-judge.json" (builtins.toJSON cfg.pi.judge);

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

      extraExtensions = lib.mkOption {
        type = lib.types.attrsOf lib.types.path;
        default = {};
        description = ''
          Additional Pi extension files managed declaratively. Attribute names
          are destination filenames under {file}`~/.pi/agent/extensions/`; values
          are Nix store paths. These sources overlay auto-discovered extensions,
          so a matching filename replaces the bundled extension.
        '';
      };

      judge = lib.mkOption {
        type = lib.types.nullOr (lib.types.submodule {
          options = {
            provider = lib.mkOption {
              type = lib.types.str;
              default = "typesafe";
              description = "SystemOne provider id (typesafe, cloudflare-workers-ai, openrouter, ...).";
            };
            model = lib.mkOption {
              type = lib.types.str;
              default = "jev-latest";
              description = "Classifier model id within the provider.";
            };
            t = lib.mkOption {
              type = lib.types.float;
              default = 0.85;
              description = "Probability required to count a call as safe (0.5 < t <= 1).";
            };
            c = lib.mkOption {
              type = lib.types.float;
              default = 0.7;
              description = "Minimum model confidence to act without prompting (0 <= c <= 1).";
            };
            timeoutMs = lib.mkOption {
              type = lib.types.int;
              default = 4000;
              description = "Per-attempt judge request timeout in milliseconds.";
            };
            profiles = lib.mkOption {
              type = lib.types.attrsOf (lib.types.submodule {
                options = {
                  t = lib.mkOption {
                    type = lib.types.float;
                    description = "Threshold t for this model.";
                  };
                  c = lib.mkOption {
                    type = lib.types.float;
                    description = "Threshold c for this model.";
                  };
                };
              });
              default = {};
              description = ''
                Per-model threshold profiles, keyed by "provider/model".
                Switching models loads the matching profile (or the top-level t/c).
              '';
            };
          };
        });
        default = null;
        description = ''
          Static judge-gate config, written to ~/.pi/agent/judge.json.
          Null (default) leaves any existing judge.json unmanaged.
          Model selection and threshold tuning at runtime happen via TUI
          commands, not here — Nix owns the slow-moving static config only.

          Example:
          {
            provider = "typesafe";
            model = "jev-latest";
            t = 0.85;
            c = 0.7;
          }
        '';
      };

      externalExtensions = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = [];
        description = ''
          External Pi extensions from the registry (see nix/pi-external-extensions.nix).
          `npm`-type entries install from npm, deployed to
          ~/.pi/agent/npm/node_modules/<name>/ and registered in settings.json.
          `file`-type entries deploy a single file to ~/.pi/agent/extensions/.
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
      {
        assertion = lib.all (name: let t = piExternalExtRegistry.${name}.type or "npm"; in t == "npm" || t == "file") allExternalExtNames;
        message = "dot-agents: external pi extension registry entries must have type \"npm\" or \"file\"";
      }
      {
        assertion = overlappingOverlayNames == [];
        message = "dot-agents: file-type external extension(s) collide with extraExtensions filenames: ${lib.concatStringsSep ", " overlappingOverlayNames}";
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
      (lib.mkIf (cfg.structure == "link" && hasEnabledPiExtensions) {
        ".pi/agent/extensions".source = piExtensionsBundle;
      })
      # Pi extension runtime dependencies (deploy if any local or external extensions enabled)
      (lib.mkIf (hasEnabledPiExtensions || enabledNpmExts != []) {
        ".pi/agent/package.json".source = piDir + "/package.json";
        ".pi/agent/node_modules".source = piNodeModules + "/node_modules";
      })
      # Judge gate static config
      (lib.mkIf (cfg.pi.judge != null) {
        ".pi/agent/judge.json".source = judgeJson;
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
      (lib.mkIf (enabledNpmExts != []) (
        lib.listToAttrs (map (name: {
            name = ".pi/agent/npm/node_modules/${piExternalExtRegistry.${name}.package}";
            value.source = "${externalExtPkgs.${name}}";
          })
          enabledNpmExts)
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
      (lib.mkIf (cfg.structure != "link" && hasEnabledPiExtensions) {
        "install-dot-agents-pi-extensions" =
          mkRsyncActivation piExtensionsBundle "${config.home.homeDirectory}/.pi/agent/extensions" cfg.structure;
      })
      # settings.json `packages` is managed authoritatively: exactly the
      # enabled npm extensions, nothing else. Removing an entry from
      # `externalExtensions` (or from the registry) removes it from
      # settings.json on the next rebuild, so Pi never tries to
      # `npm install` a stale package (hard `spawn npm ENOENT` crash when
      # npm is not on PATH). Other settings.json keys are preserved.
      # NOTE: packages installed manually via `pi install` are dropped on
      # rebuild — declare them in nix/pi-external-extensions.nix instead.
      {
        "install-dot-agents-pi-external-extensions-settings" = lib.hm.dag.entryAfter ["writeBoundary"] ''
          export PATH="${pkgs.jq}/bin:$PATH"
          SETTINGS="${config.home.homeDirectory}/.pi/agent/settings.json"
          OUR_PACKAGES='${externalExtSettingsJson}'
          ENABLED_BARE='${enabledNpmBareJson}'

          mkdir -p "$(dirname "$SETTINGS")"

          if [ -f "$SETTINGS" ]; then
            jq --argjson ours "$OUR_PACKAGES" \
              '. as $s | $s + { packages: ($ours.packages | unique) }' \
              "$SETTINGS" > "$SETTINGS.tmp" && mv "$SETTINGS.tmp" "$SETTINGS"
          else
            echo "$OUR_PACKAGES" > "$SETTINGS"
          fi

          chmod 644 "$SETTINGS"

          # Prune Nix-deployed package symlinks that are no longer enabled
          # (home.file leaves them behind). Only symlinks are touched, and
          # only when they point into /nix/store or dangle — real
          # directories (e.g. manually `pi install`ed) are never deleted.
          # Nested paths (inside a package dir) are never touched either.
          NPM_DIR="${config.home.homeDirectory}/.pi/agent/npm/node_modules"
          if [ -d "$NPM_DIR" ]; then
            find "$NPM_DIR" -maxdepth 2 -type l -print | while IFS= read -r link; do
              rel="''${link#$NPM_DIR/}"
              case "$rel" in
                *?/*?/*) continue ;; # nested inside a package dir — never touch
                @*/?*) : ;; # direct child of a scope dir — candidate
                ?*/?*) continue ;; # inside a real top-level dir — never touch
                *) : ;; # top-level — candidate
              esac
              if printf '%s' "$ENABLED_BARE" | jq -e --arg n "$rel" 'index($n) == null' >/dev/null; then
                target=$(readlink "$link")
                case "$target" in
                  /nix/store/*) rm -f "$link" ;;
                  *) [ -e "$link" ] || rm -f "$link" ;;
                esac
              fi
            done
            find "$NPM_DIR" -mindepth 1 -maxdepth 1 -type d -empty -delete 2>/dev/null || true
          fi
        '';
      }
    ];
  };
}
