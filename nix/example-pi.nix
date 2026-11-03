# Example Home Manager module for the permission gate
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

      # Static permission-gate config → ~/.pi/agent/gate.json.
      # Nix owns the slow-moving config only; thresholds are replayed from
      # the decision log before they are changed here.
      gate = {
        provider = "typesafe";
        model = "jev-latest";
        allowAt = 0.25;
        denyAt = 0.6;
        timeoutMs = 4000;
        onUncertain = "hold";
        profiles = {
          # Clef-flash hedges on every question, so it needs a tighter band.
          # Key is "provider/model" as pi-ai resolves it. The native Cloudflare
          # pair is below; through the gateway the same weights are
          # "openrouter/cloudflare/clef-flash".
          "cloudflare-workers-ai/@cf/cloudflare/clef-flash" = {
            allowAt = 0.2;
            denyAt = 0.5;
          };
        };
      };
    };
  };
}
