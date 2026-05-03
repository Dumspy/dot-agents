{
  lib,
  pkgs,
  config,
}: let
  cfg = config.myModules.home.agent-config;

  # Validate skill IDs to prevent path traversal attacks
  assertSkillId = id:
    if id == ""
    then throw "agent-config: skill/agent id cannot be empty"
    else if lib.strings.hasPrefix "/" id || lib.strings.hasInfix ".." id
    then throw "agent-config: invalid skill id '${id}' (must not start with '/' or contain '..')"
    else id;

  # Validate target destination paths
  assertRelativeDest = dest:
    if lib.strings.hasPrefix "/" dest || lib.strings.hasInfix ".." dest
    then throw "agent-config: target.dest must be relative and not contain '..': ${dest}"
    else dest;

  # Recursively discover skills from a source path
  # Skills are directories containing SKILL.md
  # maxDepth controls how deep to search (1 = only direct children)
  # sourceName is used as the skill ID when skill is found at root level
  discoverSkills = sourceName: sourcePath: skillsSubdir: maxDepth: let
    fullPath =
      if skillsSubdir == "."
      then sourcePath
      else sourcePath + "/${skillsSubdir}";

    pathExists = builtins.pathExists fullPath;

    scan = path: relParts: depth: let
      entries = builtins.readDir path;
      relPath = lib.concatStringsSep "/" relParts;
      hasSkillMd = entries ? "SKILL.md";

      current =
        if hasSkillMd
        then [
          {
            id = assertSkillId (
              if relPath == ""
              then sourceName
              else relPath
            );
            inherit relPath;
            absPath = path;
          }
        ]
        else [];

      dirs = lib.filter (
        n:
          entries.${n} == "directory"
      ) (lib.attrNames entries);

      deeper =
        if depth < maxDepth
        then lib.concatMap (n: scan (path + "/${n}") (relParts ++ [n]) (depth + 1)) dirs
        else [];
    in
      current ++ deeper;
  in
    if pathExists
    then
      lib.listToAttrs (map (skill: {
        name = skill.id;
        value = skill;
      }) (scan fullPath [] 0))
    else {};

  # Build catalog of all available skills from sources
  buildCatalog = sources: localSkills: let
    # Discover from local skills first (use "local" as source name)
    localDiscovered = discoverSkills "local" localSkills "." 1;
    localCatalog =
      lib.mapAttrs (skillName: skill: {
        sourceName = "local";
        inherit skillName;
        path = skill.absPath;
      })
      localDiscovered;

    # Merge in skills from each source
    mergeSources = acc: sourceName: let
      sourceSpec = sources.${sourceName};
      maxDepth = sourceSpec.maxDepth or 1;
      discovered = discoverSkills sourceName sourceSpec.path sourceSpec.skillsSubdir maxDepth;
      withSource =
        lib.mapAttrs (skillName: skill: {
          inherit sourceName skillName;
          path = skill.absPath;
        })
        discovered;
      # Check for duplicates
      duplicates = lib.filter (name: builtins.hasAttr name acc) (lib.attrNames withSource);
      _ =
        lib.assertMsg (duplicates == [])
        "agent-config: duplicate skill(s) ${lib.concatStringsSep ", " duplicates} from source '${sourceName}' (already defined in '${(acc.${builtins.head duplicates} or {}).sourceName or "unknown"}')";
    in
      acc // withSource;
  in
    lib.foldl' mergeSources localCatalog (lib.attrNames sources);

  # Build a derivation containing selected skills
  # Returns { drv, names } where names is the list of skill names in the bundle
  mkSkillsBundle = catalog: enabledSkills: let
    selectedSkills = lib.filterAttrs (name: _: lib.elem name enabledSkills) catalog;
    missingSkills = lib.filter (name: !(builtins.hasAttr name catalog)) enabledSkills;
    _ =
      lib.assertMsg (missingSkills == [])
      "Unknown skills requested: ${lib.concatStringsSep ", " missingSkills}. Available: ${lib.concatStringsSep ", " (lib.attrNames catalog)}";
    names = lib.attrNames selectedSkills;
    drv = pkgs.runCommand "skills-bundle" {preferLocalBuild = true;} ''
      mkdir -p $out
      ${lib.concatMapStringsSep "\n" (skillName: let
          skill = selectedSkills.${skillName};
          safeName = lib.replaceStrings ["/"] ["-"] skillName;
          skillPath = builtins.path {
            path = skill.path;
            name = "agent-skill-${safeName}";
          };
        in ''
          mkdir -p "$out/$(dirname ${lib.escapeShellArg skillName})"
          ln -s ${lib.escapeShellArg skillPath} "$out/${lib.escapeShellArg skillName}"
        '')
        names}
    '';
  in {inherit drv names;};

  # Discover agents from a single directory path
  # Returns an attrset of { agentName = { sourceName, path }; }
  discoverAgentsFromPath = sourceName: agentsPath: let
    exists = builtins.pathExists agentsPath;
    entries =
      if exists
      then builtins.readDir agentsPath
      else {};
    mdFiles =
      lib.filterAttrs (
        name: type:
          type == "regular" && lib.hasSuffix ".md" name
      )
      entries;
  in
    lib.mapAttrs' (fileName: _: let
      agentId = assertSkillId (lib.removeSuffix ".md" fileName);
    in {
      name = agentId;
      value = {
        inherit sourceName;
        path = agentsPath + "/${fileName}";
      };
    })
    mdFiles;

  # Discover all available agents from sources and local agents
  # Returns an attrset of { agentName = { sourceName, path }; }
  discoverAgents = sources: localAgents: let
    # Discover from local agents first
    localDiscovered = discoverAgentsFromPath "local" localAgents;

    # Discover from each source
    perSource =
      lib.mapAttrsToList (
        sourceName: sourceSpec:
          discoverAgentsFromPath sourceName "${sourceSpec.path}/${sourceSpec.agentsSubdir}"
      )
      sources;

    # Merge all sources, checking for duplicates
    merged =
      lib.foldl' (
        acc: agents: let
          duplicates = lib.filter (name: builtins.hasAttr name acc) (lib.attrNames agents);
          _ =
            lib.assertMsg (duplicates == [])
            "agent-config: duplicate agent(s) ${lib.concatStringsSep ", " duplicates}";
        in
          acc // agents
      )
      localDiscovered
      perSource;
  in
    merged;

  # Build a derivation containing selected agents
  # Returns { drv, names } where names is the list of agent filenames in the bundle
  mkAgentsBundle = agentsCatalog: enabledAgents: let
    selectedAgents = lib.filterAttrs (name: _: lib.elem name enabledAgents) agentsCatalog;
    missingAgents = lib.filter (name: !(builtins.hasAttr name agentsCatalog)) enabledAgents;
    _ =
      lib.assertMsg (missingAgents == [])
      "Unknown agents requested: ${lib.concatStringsSep ", " missingAgents}. Available: ${lib.concatStringsSep ", " (lib.attrNames agentsCatalog)}";

    names = map (n: "${n}.md") (lib.attrNames selectedAgents);
    drv = pkgs.runCommand "agents-bundle" {preferLocalBuild = true;} ''
      mkdir -p $out
      ${lib.concatMapStringsSep "\n" (agentName: let
          agent = selectedAgents.${agentName};
          safeName = lib.replaceStrings ["/"] ["-"] agentName;
          agentPath = builtins.path {
            path = agent.path;
            name = "agent-${safeName}.md";
          };
        in ''
          ln -s ${lib.escapeShellArg agentPath} "$out/${lib.escapeShellArg agentName}.md"
        '')
        (lib.attrNames selectedAgents)}
    '';
  in {inherit drv names;};

  # Source submodule type (supports both skills and agents)
  sourceType = lib.types.submodule {
    options = {
      path = lib.mkOption {
        type = lib.types.path;
        description = "Path to the flake input or local directory";
      };
      skillsSubdir = lib.mkOption {
        type = lib.types.str;
        default = "skills";
        description = "Subdirectory for skills (directories with SKILL.md)";
      };
      maxDepth = lib.mkOption {
        type = lib.types.int;
        default = 1;
        description = "How deep to search for skills (1 = direct children only)";
      };
      agentsSubdir = lib.mkOption {
        type = lib.types.str;
        default = "agents";
        description = "Subdirectory for agents (.md files)";
      };
    };
  };

  # Target submodule type
  targetType = lib.types.submodule {
    options = {
      dest = lib.mkOption {
        type = lib.types.str;
        description = "Destination path relative to home directory";
      };
      structure = lib.mkOption {
        type = lib.types.enum ["link" "symlink-tree" "copy-tree"];
        default = "symlink-tree";
        description = "How to install: link, symlink-tree, or copy-tree";
      };
    };
  };
in {
  options.myModules.home.agent-config = {
    enable = lib.mkEnableOption "unified agent configuration (skills + agents)";

    sources = lib.mkOption {
      type = lib.types.attrsOf sourceType;
      default = {};
      description = "Named sources for skills and agents";
    };

    skills = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "List of skill names to enable (autodiscovered from sources)";
    };

    enableAllSkills = lib.mkOption {
      type = lib.types.either lib.types.bool (lib.types.listOf lib.types.str);
      default = false;
      description = ''
        Enable all discovered skills.
        - true: enable all skills from all sources
        - ["source1", "source2"]: enable all skills from specified sources
        - false: only enable skills listed in 'skills'
      '';
    };

    agents = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "List of agent names to enable (autodiscovered from sources)";
    };

    enableAllAgents = lib.mkOption {
      type = lib.types.either lib.types.bool (lib.types.listOf lib.types.str);
      default = false;
      description = ''
        Enable all discovered agents.
        - true: enable all agents from all sources
        - ["source1", "source2"]: enable all agents from specified sources
        - false: only enable agents listed in 'agents'
      '';
    };

    localSkills = lib.mkOption {
      type = lib.types.path;
      description = "Path to local skills directory";
    };

    localAgents = lib.mkOption {
      type = lib.types.path;
      description = "Path to local agents directory";
    };

    skillsTarget = lib.mkOption {
      type = targetType;
      default = {
        dest = ".config/opencode/skills";
        structure = "symlink-tree";
      };
      description = "Target for skills installation";
    };

    agentsTarget = lib.mkOption {
      type = targetType;
      default = {
        dest = ".config/opencode/agents";
        structure = "symlink-tree";
      };
      description = "Target for agents installation";
    };
  };

  config = lib.mkIf cfg.enable (let
    # Build catalogs
    skillsCatalog = buildCatalog cfg.sources cfg.localSkills;
    agentsCatalog = discoverAgents cfg.sources cfg.localAgents;

    # Helper to compute enabled items based on enableAll + explicit list
    computeEnabled = {
      catalog,
      enableAll,
      explicit,
      itemType,
    }: let
      allEnabled =
        if enableAll == true
        then lib.attrNames catalog
        else if lib.isList enableAll
        then let
          invalidSources = lib.filter (s: s != "local" && !(builtins.hasAttr s cfg.sources)) enableAll;
          _ =
            lib.assertMsg (invalidSources == [])
            "agent-config: enableAll${itemType} refers to unknown sources: ${lib.concatStringsSep ", " invalidSources}";
        in
          lib.filter (
            name:
              lib.elem catalog.${name}.sourceName enableAll
          ) (lib.attrNames catalog)
        else [];
    in
      lib.unique (allEnabled ++ explicit);

    enabledSkillNames = computeEnabled {
      catalog = skillsCatalog;
      enableAll = cfg.enableAllSkills;
      explicit = cfg.skills;
      itemType = "Skills";
    };

    enabledAgentNames = computeEnabled {
      catalog = agentsCatalog;
      enableAll = cfg.enableAllAgents;
      explicit = cfg.agents;
      itemType = "Agents";
    };

    skills = mkSkillsBundle skillsCatalog enabledSkillNames;
    agents = mkAgentsBundle agentsCatalog enabledAgentNames;

    # Helper to create home.file entries for a bundle
    mkBundleFiles = bundle: destBase:
      lib.listToAttrs (map (name: {
          name = "${destBase}/${name}";
          value.source = "${bundle.drv}/${name}";
        })
        bundle.names);

    # Helper to create activation script for rsync-based install
    mkRsyncActivation = bundle: destPath: structure: let
      rsyncFlags =
        if structure == "symlink-tree"
        then "-a --delete"
        else "-aL --delete";
    in
      lib.hm.dag.entryAfter ["writeBoundary"] ''
        mkdir -p "${destPath}"
        ${pkgs.rsync}/bin/rsync ${rsyncFlags} "${bundle.drv}/" "${destPath}/"
      '';
    # Validated destination paths
    skillsDest = assertRelativeDest cfg.skillsTarget.dest;
    agentsDest = assertRelativeDest cfg.agentsTarget.dest;
  in {
    # Link mode: use home.file for symlinks
    home.file = lib.mkMerge [
      (lib.mkIf (cfg.skillsTarget.structure == "link") (
        mkBundleFiles skills skillsDest
      ))
      (lib.mkIf (cfg.agentsTarget.structure == "link") (
        mkBundleFiles agents agentsDest
      ))
    ];

    # Non-link modes: use activation scripts with rsync
    home.activation = lib.mkMerge [
      (lib.mkIf (cfg.skillsTarget.structure != "link") {
        "install-skills" =
          mkRsyncActivation
          skills
          "${config.home.homeDirectory}/${skillsDest}"
          cfg.skillsTarget.structure;
      })
      (lib.mkIf (cfg.agentsTarget.structure != "link") {
        "install-agents" =
          mkRsyncActivation
          agents
          "${config.home.homeDirectory}/${agentsDest}"
          cfg.agentsTarget.structure;
      })
    ];
  });
}
