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
          "*" = "allow";
          # Secrets & credentials
          ".direnv/*" = "deny";
          ".env" = "deny";
          "*.env" = "deny";
          "*.env.*" = "deny";
          "*.envrc" = "deny";
          "secrets/*" = "deny";
          # Private keys & auth
          ".ssh/*" = "deny";
          ".gnupg/*" = "deny";
          ".config/1password/*" = "deny";
          "*.key" = "deny";
          "*.pem" = "deny";
          "*.p12" = "deny";
          "*.pfx" = "deny";
          # Cloud/container credentials
          ".aws/*" = "deny";
          ".docker/*" = "deny";
          ".kube/*" = "deny";
          # Version control internals
          ".git/*" = "deny";
          ".gitmodules" = "deny";
          # Build artifacts (large, noisy)
          "node_modules/*" = "deny";
          ".venv/*" = "deny";
          "venv/*" = "deny";
          "dist/*" = "deny";
          "build/*" = "deny";
          "target/*" = "deny";
        };

        write = {
          "*" = "ask";
          ".env" = "deny";
          ".git/*" = "deny";
          "node_modules/*" = "deny";
          ".venv/*" = "deny";
          "venv/*" = "deny";
        };

        edit = {
          "*" = "ask";
          ".env" = "deny";
          ".git/*" = "deny";
          "node_modules/*" = "deny";
          ".venv/*" = "deny";
          "venv/*" = "deny";
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
