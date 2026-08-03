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
    version = "2.11.0";
    description = "Use MCP servers with Pi — one proxy tool instead of hundreds";
    # Tarball hash (SRI)
    hash = "sha256-fUVwNzZAxIpHK9HqbT+x9FEp3ZPGmi6//2dX4eEN0lk=";
    # Installed output hash (SRI, recursive). May shift when transitive deps
    # publish new patches — update with the 'got:' value from the build error.
    npmDepsHash = "sha256-AZtbVDlHp8mrsk3D2r1cDwgpftaTEuo5zCPdBGKU0kE=";
  };
}
