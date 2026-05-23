{
  description = "Universal agent configuration: skills, agents, commands, and extensions for Pi, OpenCode, and future agents.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # External skill sources
    vercel-agent-skills = {
      url = "github:vercel-labs/agent-skills";
      flake = false;
    };

    expo-agent-skills = {
      url = "github:expo/skills";
      flake = false;
    };

    agent-browser = {
      url = "github:vercel-labs/agent-browser";
      flake = false;
    };

    anthropics-agent-skills = {
      url = "github:anthropics/skills";
      flake = false;
    };

    dex-agent-skills = {
      url = "github:dcramer/dex";
      flake = false;
    };

    sentry-skills = {
      url = "github:getsentry/skills";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    home-manager,
    vercel-agent-skills,
    expo-agent-skills,
    agent-browser,
    anthropics-agent-skills,
    dex-agent-skills,
    sentry-skills,
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
        system:
          f {
            inherit system;
            pkgs = nixpkgs.legacyPackages.${system};
          }
      );

    # External skill sources passed to the registry
    externalSources = {
      inherit vercel-agent-skills expo-agent-skills agent-browser anthropics-agent-skills dex-agent-skills sentry-skills;
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

    devShells = eachSystem ({pkgs, ...}: {
      default = pkgs.mkShell {
        packages = [pkgs.nodejs pkgs.rsync];
        shellHook = ''
          cd pi && npm install
        '';
      };
    });

    homeModules =
      import ./nix/home-modules.nix {inherit self lib;}
      // {
        default = import ./nix/home-manager.nix {inherit self externalSources;};
      };
  };
}
