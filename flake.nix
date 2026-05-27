{
  description = "Universal agent configuration: skills, agents, commands, and extensions for Pi, OpenCode, and future agents.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # External skill sources
    agent-browser = {
      url = "github:vercel-labs/agent-browser";
      flake = false;
    };

    anthropics-agent-skills = {
      url = "github:anthropics/skills";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    home-manager,
    git-hooks,
    agent-browser,
    anthropics-agent-skills,
  }: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
      "x86_64-darwin"
    ];

    lib = nixpkgs.lib;

    eachSystem = f:
      lib.genAttrs systems (
        system: let
          pkgs = nixpkgs.legacyPackages.${system};
          pre-commit-check = git-hooks.lib.${system}.run {
            src = ./.;
            hooks = {
              alejandra.enable = true;
            };
          };
        in
          f {
            inherit system pkgs pre-commit-check;
          }
      );

    # External skill sources passed to the registry
    externalSources = {
      inherit agent-browser anthropics-agent-skills;
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
        }
    );

    formatter = eachSystem ({pkgs, ...}: pkgs.alejandra);

    checks = eachSystem ({pre-commit-check, ...}: {
      inherit pre-commit-check;
    });

    devShells = eachSystem ({
      pkgs,
      pre-commit-check,
      ...
    }: {
      default = pkgs.mkShell {
        shellHook =
          pre-commit-check.shellHook
          + ''
            cd pi && npm install
          '';
        packages = [pkgs.nodejs pkgs.rsync pkgs.alejandra];
      };
    });

    homeModules.default = import ./nix/home-manager.nix {inherit self externalSources;};
  };
}
