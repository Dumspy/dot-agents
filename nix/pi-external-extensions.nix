# Registry of external Pi extensions: single extension files fetched from a
# pinned URL and deployed to ~/.pi/agent/extensions/<filename>. For upstreams
# that ship a plain file in a git repo. Each entry needs `filename`, `url`,
# and `hash`. See README.md → "External Pi Extensions".
{
  # Herdr agent-state reporting for Pi — lets Herdr resume the same Pi
  # session after a server restart and report working/blocked/idle state
  # instead of reading the screen. Replaces `herdr integration install pi`.
  # https://herdr.dev/docs/integrations/#pi
  # Source: https://github.com/herdrdev/herdr/blob/v0.9.3/src/integration/assets/pi/herdr-agent-state.ts
  "herdr-agent-state" = {
    filename = "herdr-agent-state.ts";
    # Pinned to the v0.9.3 tag commit (immutable). Tracks latest upstream;
    # v9 only adds Windows session-path support over v8, so Unix behavior
    # is identical when paired with older herdr binaries.
    url = "https://raw.githubusercontent.com/herdrdev/herdr/065ef9d6a531c49fb8bee7e818ef837065b21ee9/src/integration/assets/pi/herdr-agent-state.ts";
    hash = "sha256-LFJy1zK0dbv5GgJyA7H5jSX+Q9LBQCUwpEKyiK6soeQ=";
    description = "Herdr agent-state reporting for Pi (session restore + working/blocked/idle)";
  };
}
