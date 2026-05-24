# Example Home Manager module for Pi permissions
# Add this to your home.nix or import it alongside opencode.nix

{ config, lib, ... }: {
  programs.dot-agents = {
    enable = true;

    pi = {
      # Auto-discover all extensions in pi/extensions/
      # Set to [] to disable, or a specific list to cherry-pick
      extensions = null;

      # Permission rules — mirrors the OpenCode permission system
      permissions = {
        read = {
          "**" = "allow";
          # Secrets & credentials
          ".direnv/*" = "deny";
          "**/.direnv/*" = "deny";
          ".env" = "deny";
          "**/.env" = "deny";
          "**/*.env" = "deny";
          "*.env" = "deny";
          "*.env.*" = "deny";
          "**/.env.*" = "deny";
          "**/*.env.*" = "deny";
          "*.envrc" = "deny";
          "**/*.envrc" = "deny";
          "secrets/*" = "deny";
          "**/secrets/*" = "deny";
          # Private keys & auth
          ".ssh/*" = "deny";
          "**/.ssh/*" = "deny";
          ".gnupg/*" = "deny";
          "**/.gnupg/*" = "deny";
          ".config/1password/*" = "deny";
          "**/.config/1password/*" = "deny";
          "*.key" = "deny";
          "**/*.key" = "deny";
          "*.pem" = "deny";
          "**/*.pem" = "deny";
          "*.p12" = "deny";
          "**/*.p12" = "deny";
          "*.pfx" = "deny";
          "**/*.pfx" = "deny";
          # Cloud/container credentials
          ".aws/*" = "deny";
          "**/.aws/*" = "deny";
          ".docker/*" = "deny";
          "**/.docker/*" = "deny";
          ".kube/*" = "deny";
          "**/.kube/*" = "deny";
          # Version control internals
          ".git/*" = "deny";
          "**/.git/*" = "deny";
          ".gitmodules" = "deny";
          "**/.gitmodules" = "deny";
          # Build artifacts (large, noisy)
          "node_modules/*" = "deny";
          "**/node_modules/*" = "deny";
          ".venv/*" = "deny";
          "**/.venv/*" = "deny";
          "venv/*" = "deny";
          "**/venv/*" = "deny";
          "dist/*" = "deny";
          "**/dist/*" = "deny";
          "build/*" = "deny";
          "**/build/*" = "deny";
          "target/*" = "deny";
          "**/target/*" = "deny";
        };

        write = {
          "**" = "allow";
          ".env" = "deny";
          "**/.env" = "deny";
          "**/*.env" = "deny";
          ".git/*" = "deny";
          "**/.git/*" = "deny";
          "node_modules/*" = "deny";
          "**/node_modules/*" = "deny";
          ".venv/*" = "deny";
          "**/.venv/*" = "deny";
          "venv/*" = "deny";
          "**/venv/*" = "deny";
        };

        edit = {
          "**" = "allow";
          ".env" = "deny";
          "**/.env" = "deny";
          "**/*.env" = "deny";
          ".git/*" = "deny";
          "**/.git/*" = "deny";
          "node_modules/*" = "deny";
          "**/node_modules/*" = "deny";
          ".venv/*" = "deny";
          "**/.venv/*" = "deny";
          "venv/*" = "deny";
          "**/venv/*" = "deny";
        };

        bash = {
          "*" = "ask";
          "ls*" = "allow";
          "pwd" = "allow";
          "git status*" = "allow";
          "git diff*" = "allow";
          "git log*" = "allow";
          "dex *" = "allow";
        };

        webfetch = "ask";
      };
    };
  };
}
