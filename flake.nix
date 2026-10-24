{
  description = "Universal agent configuration: skills, agents, commands, and extensions for Pi, OpenCode, and future agents.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Used only by `checks` (`homeManagerConfiguration`). `homeModules` does
    # not import it. Consumers should follow their own Home Manager so the
    # lock does not grow a second copy:
    #   inputs.<name>.inputs.home-manager.follows = "home-manager";
    home-manager = {
      url = "github:nix-community/home-manager/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Dev shell and `nix flake check` only. Not used by homeModules or packages.
    # Consumers still lock it (and its flake-compat / gitignore inputs).
    git-hooks = {
      url = "github:cachix/git-hooks.nix/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # External skill sources. `flake = false` keeps this a plain source tree.
    anthropics-agent-skills = {
      url = "github:anthropics/skills/main";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    home-manager,
    git-hooks,
    anthropics-agent-skills,
  }: let
    # x86_64-darwin still evaluates on nixos-unstable, with a removal warning.
    # aarch64-linux and x86_64-darwin pi-node-modules hashes are placeholders.
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
      "x86_64-darwin"
    ];

    inherit (nixpkgs) lib;

    eachSystem = f:
      lib.genAttrs systems (
        system: let
          pkgs = nixpkgs.legacyPackages.${system};
          pre-commit-check = git-hooks.lib.${system}.run {
            src = ./.;
            hooks = {
              alejandra.enable = true;
              deadnix = {
                enable = true;
                settings = {
                  # Match the owner's dotfiles devenv hook: module arguments
                  # such as `{ config, lib, ... }` are part of the signature.
                  noLambdaArg = true;
                  noLambdaPatternNames = true;
                };
              };
            };
          };
        in
          f {
            inherit system pkgs pre-commit-check;
          }
      );

    # External skill sources passed to the registry
    externalSources = {
      inherit anthropics-agent-skills;
    };

    homeModule = import ./nix/home-manager.nix {inherit self externalSources;};

    # Minimal Home Manager user for module evaluation. Darwin homes are /Users.
    testUser = pkgs: {
      home = {
        username = "testuser";
        homeDirectory =
          if pkgs.stdenv.hostPlatform.isDarwin
          then "/Users/testuser"
          else "/home/testuser";
        stateVersion = "24.11";
      };
    };
  in {
    packages = eachSystem (
      {pkgs, ...}:
        (import ./nix/packages.nix {
          inherit pkgs lib;
          inherit externalSources;
        })
        // {
          stow-tree = import ./nix/stow-tree.nix {
            inherit pkgs lib self externalSources;
          };
          pi-node-modules = pkgs.callPackage ./nix/pi-node-modules.nix {};
        }
    );

    formatter = eachSystem ({pkgs, ...}: pkgs.alejandra);

    checks = eachSystem (
      {
        system,
        pkgs,
        pre-commit-check,
        ...
      }: let
        evalHome = extra:
          (home-manager.lib.homeManagerConfiguration {
            inherit pkgs;
            modules = [
              self.homeModules.default
              (testUser pkgs)
              extra
            ];
          }).activationPackage;
      in {
        inherit pre-commit-check;
        inherit
          (self.packages.${system})
          pi-node-modules
          stow-tree
          herdr-agent-state
          ;
        # statix exits 0 on warnings, so fail the check when it prints any.
        statix = pkgs.runCommand "statix-check" {nativeBuildInputs = [pkgs.statix];} ''
          set +e
          log=$(statix check --format errfmt ${./.} 2>&1)
          status=$?
          set -e
          if [ "$status" -ne 0 ] || [ -n "$log" ]; then
            printf '%s\n' "$log" >&2
            exit 1
          fi
          touch $out
        '';
        # Defaults: rsync install, external extensions off.
        home-manager-module = evalHome {
          programs.dot-agents.enable = true;
        };
        # Link install plus every registry extension (the dotfiles shape).
        home-manager-module-linked = evalHome {
          programs.dot-agents = {
            enable = true;
            structure = "link";
            pi.externalExtensions = null;
          };
        };
      }
    );

    devShells = eachSystem ({
      pkgs,
      pre-commit-check,
      ...
    }: {
      default = pkgs.mkShell {
        shellHook =
          pre-commit-check.shellHook
          + ''
            # Stay in the caller's directory. `cd` made `nix develop -c`
            # run in pi/ (CI's alejandra --check then missed the Nix files).
            if [ -f pi/package.json ]; then
              npm install --prefix pi
            fi
          '';
        packages = [
          pkgs.nodejs
          pkgs.rsync
          pkgs.alejandra
          pkgs.deadnix
          pkgs.statix
        ];
      };
    });

    homeModules.default = homeModule;

    # Same module. `homeModules` is the name Home Manager documents;
    # `homeManagerModules` is the other name in wide use.
    homeManagerModules = self.homeModules;
  };
}
