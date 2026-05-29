{
  pkgs,
  lib,
  self,
  externalSources,
}: let
  registry = import ./skills.nix {inherit externalSources;};
  system = pkgs.stdenv.hostPlatform.system;

  # All skill packages (filter to only registry entries to avoid self-reference)
  skillPkgs = lib.genAttrs (builtins.attrNames registry) (
    name: self.packages.${system}.${name}
  );

  # Copy a skill into the tree
  copySkill = name: pkg: ''
    mkdir -p $out/.agents/skills
    cp -rL ${pkg}/share/skills/${name} $out/.agents/skills/${name}
  '';

  # Copy agent definitions
  agentsDir = ../opencode/agents;
  hasAgents = builtins.pathExists agentsDir;
  copyAgents = lib.optionalString hasAgents ''
    mkdir -p $out/.config/opencode/agents
    for f in ${agentsDir}/*.md; do
      cp -L "$f" $out/.config/opencode/agents/$(basename "$f")
    done
  '';

  # Copy opencode commands
  commandsDir = ../opencode/commands;
  hasCommands = builtins.pathExists commandsDir;
  copyCommands = lib.optionalString hasCommands ''
    mkdir -p $out/.config/opencode/commands
    for f in ${commandsDir}/*.md; do
      cp -L "$f" $out/.config/opencode/commands/$(basename "$f")
    done
  '';

  # Copy pi-specific skills
  piSkillsDir = ../pi/skills;
  hasPiSkills = builtins.pathExists piSkillsDir;
  copyPiSkills = lib.optionalString hasPiSkills ''
    mkdir -p $out/.pi/agent/skills
    for d in ${piSkillsDir}/*; do
      if [ -d "$d" ]; then
        cp -rL "$d" $out/.pi/agent/skills/$(basename "$d")
      fi
    done
  '';

  # Copy opencode-specific skills
  opencodeSkillsDir = ../opencode/skills;
  hasOpencodeSkills = builtins.pathExists opencodeSkillsDir;
  copyOpencodeSkills = lib.optionalString hasOpencodeSkills ''
    mkdir -p $out/.config/opencode/skills
    for d in ${opencodeSkillsDir}/*; do
      if [ -d "$d" ]; then
        cp -rL "$d" $out/.config/opencode/skills/$(basename "$d")
      fi
    done
  '';

  # Copy pi-specific extensions
  piExtensionsDir = ../pi/extensions;
  hasPiExtensions = builtins.pathExists piExtensionsDir;
  copyPiExtensions = lib.optionalString hasPiExtensions ''
    mkdir -p $out/.pi/agent/extensions
    ${pkgs.rsync}/bin/rsync -aL \
      --exclude='*.test.ts' --exclude='*.test.js' \
      --exclude='*.spec.ts' --exclude='*.spec.js' \
      --exclude='*.test.tsx' --exclude='*.spec.tsx' \
      --exclude='test/' --exclude='__tests__/' \
      ${piExtensionsDir}/ $out/.pi/agent/extensions/
  '';

  # Copy pi-specific themes
  piThemesDir = ../pi/themes;
  hasPiThemes = builtins.pathExists piThemesDir;
  copyPiThemes = lib.optionalString hasPiThemes ''
    mkdir -p $out/.pi/agent/themes
    for f in ${piThemesDir}/*.json; do
      if [ -f "$f" ]; then
        cp -L "$f" $out/.pi/agent/themes/$(basename "$f")
      fi
    done
  '';
in
  pkgs.runCommand "dot-agents-stow-tree" {
    preferLocalBuild = true;
    nativeBuildInputs = [pkgs.rsync];
  } ''
    mkdir -p $out

    # Universal skills -> ~/.agents/skills/
    ${lib.concatStringsSep "\n" (lib.mapAttrsToList copySkill skillPkgs)}

    # Agents -> ~/.config/opencode/agents/
    ${copyAgents}

    # Commands -> ~/.config/opencode/commands/
    ${copyCommands}

    # Pi-specific skills -> ~/.pi/agent/skills/
    ${copyPiSkills}

    # Pi-specific extensions -> ~/.pi/agent/extensions/
    ${copyPiExtensions}

    # Pi-specific themes -> ~/.pi/agent/themes/
    ${copyPiThemes}

    # OpenCode-specific skills -> ~/.config/opencode/skills/
    ${copyOpencodeSkills}
  ''
