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
      inherit anthropics-agent-skills;
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
        # Minimal home-manager configuration to validate the module evaluates
        # and all fixed-output derivations (e.g. pi-node-modules) build.
        hmConfig = home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          modules = [
            self.homeModules.default
            {
              home.username = "testuser";
              home.homeDirectory = "/home/testuser";
              home.stateVersion = "24.11";
              programs.dot-agents.enable = true;
            }
          ];
        };
      in {
        inherit pre-commit-check;
        pi-node-modules = self.packages.${system}.pi-node-modules;
        home-manager-module = hmConfig.activationPackage;
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
            cd pi && npm install
          '';
        packages = [pkgs.nodejs pkgs.rsync pkgs.alejandra];
      };
    });

    homeModules.default = import ./nix/home-manager.nix {inherit self externalSources;};
  };
}
