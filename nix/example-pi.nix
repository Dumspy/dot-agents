# Example Home Manager module for the judge gate
# Add this to your home.nix or import it alongside opencode.nix
{
  config,
  lib,
  ...
}: {
  programs.dot-agents = {
    enable = true;

    pi = {
      # Auto-discover all extensions in pi/extensions/
      # Set to [] to disable, or a specific list to cherry-pick
      extensions = null;

      # Static judge-gate config → ~/.pi/agent/judge.json.
      # Nix owns the slow-moving config only; model switching and
      # threshold tuning happen at runtime via /judge TUI commands.
      judge = {
        provider = "typesafe";
        model = "jev-latest";
        t = 0.85;
        c = 0.7;
        timeoutMs = 4000;
        profiles = {
          # "typesafe/jev-latest" = { t = 0.85; c = 0.7; };
        };
      };
    };
  };
}
