# Registry of external Pi extensions.
# See README.md → "External Pi Extensions" for architecture and the
# step-by-step guide for adding a new entry.
#
# Two entry types are supported:
# - `type = "npm"`: third-party npm package, installed via Pi's package
#   manager from ~/.pi/agent/npm/node_modules/ and registered in
#   settings.json. Needs `package`, `version`, `hash`, `npmDepsHash`.
# - `type = "file"`: single extension file fetched from a URL, deployed
#   directly to ~/.pi/agent/extensions/<filename>. Needs `filename`,
#   `url`, `hash`. For extensions whose upstream is a plain file in a
#   git repo (not an npm package).
{
  # Herdr agent-state reporting for Pi — lets Herdr resume the same Pi
  # session after a server restart and report working/blocked/idle state
  # instead of reading the screen. Replaces `herdr integration install pi`.
  # https://herdr.dev/docs/integrations/#pi
  # Source: https://github.com/herdrdev/herdr/blob/v0.9.3/src/integration/assets/pi/herdr-agent-state.ts
  "herdr-agent-state" = {
    type = "file";
    filename = "herdr-agent-state.ts";
    # Pinned to the v0.9.3 tag commit (immutable). Tracks latest upstream;
    # v9 only adds Windows session-path support over v8, so Unix behavior
    # is identical when paired with older herdr binaries.
    url = "https://raw.githubusercontent.com/herdrdev/herdr/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/pi/herdr-agent-state.ts";
    hash = "sha256-LFJy1zK0dbv5GgJyA7H5jSX+Q9LBQCUwpEKyiK6soeQ=";
    description = "Herdr agent-state reporting for Pi (session restore + working/blocked/idle)";
  };

  # Preserved example (disabled): pi-mcp-adapter — Use MCP servers with Pi
  # without burning context.
  # https://pi.dev/packages/pi-mcp-adapter
  # https://github.com/nicobailon/pi-mcp-adapter
  # "pi-mcp-adapter" = {
  #   type = "npm";
  #   package = "pi-mcp-adapter";
  #   version = "2.32.1";
  #   description = "Use MCP servers with Pi — one proxy tool instead of hundreds";
  #   # Tarball hash (SRI)
  #   hash = "sha256-X3t5/hGGmZZ7HFJNi7ku5ZOdEIrNk0Is7q5+sqOWMIc=";
  #   # Installed output hash (SRI, recursive) for `npm ci` against
  #   # nix/external-locks/<package>-<version>.package-lock.json.
  #   # Stable until version or lockfile changes. Get it via:
  #   #   nix build .#pi-mcp-adapter --rebuild 2>&1 | grep 'got:'
  #   npmDepsHash = "sha256-7a4gnqgtwaIgvpvtXgW2x/mzLn00V7GiOFvbOKQMMv4=";
  # };
}
