# Registry of external Pi extensions.
# See README.md → "External Pi Extensions" for architecture and the
# step-by-step guide for adding a new entry.
{
  # pi-mcp-adapter — Use MCP servers with Pi without burning context.
  # https://pi.dev/packages/pi-mcp-adapter
  # https://github.com/nicobailon/pi-mcp-adapter
  "pi-mcp-adapter" = {
    type = "npm";
    package = "pi-mcp-adapter";
    version = "2.32.1";
    description = "Use MCP servers with Pi — one proxy tool instead of hundreds";
    # Tarball hash (SRI)
    hash = "sha256-X3t5/hGGmZZ7HFJNi7ku5ZOdEIrNk0Is7q5+sqOWMIc=";
    # Installed output hash (SRI, recursive). May shift when transitive deps
    # publish new patches — update with the 'got:' value from the build error.
    npmDepsHash = "sha256-YjoGtb8AzDPZCnGcDg7g5V9fApJCjmhtuImrsnoS4lg=";
  };
}
