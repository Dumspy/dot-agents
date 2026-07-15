# Registry of external Pi extensions available for installation.
#
# External extensions are third-party npm packages that Pi loads via its
# package manager. Pi discovers them through the `packages` array in
# settings.json (~/.pi/agent/settings.json global, .pi/settings.json project).
#
# How Pi loads an npm package:
#   1. Reads settings.json → "packages": ["pi-mcp-adapter"]
#   2. Looks for the package in ~/.pi/agent/npm/<name>/ (global)
#      or .pi/npm/<name>/ (project)
#   3. Reads package.json → pi.extensions → loads the extension entry point
#
# Architecture:
#   Registry (this file)
#     ├── Nix:  packages.nix builds each entry → ~/.pi/agent/npm/<name>/
#     │         home-manager.nix generates settings.json with packages array
#     └── Stow: setup.sh runs `pi install npm:<name>` for each entry
#
# To add a new extension, see README.md → "Adding a new external extension"
# for the complete step-by-step guide.
{
  # pi-mcp-adapter — Use MCP servers with Pi without burning context.
  # Provides a single proxy tool (~200 tokens) instead of hundreds per server.
  # Servers are lazy by default (connect on first use, disconnect on idle).
  # https://pi.dev/packages/pi-mcp-adapter
  # https://github.com/nicobailon/pi-mcp-adapter
  #
  # To update: bump version, fetch new tarball hash, set npmDepsHash to
  # lib.fakeSha256, rebuild, and copy the 'got:' hash from the error.
  "pi-mcp-adapter" = {
    type = "npm";
    package = "pi-mcp-adapter";
    version = "2.11.0";
    description = "Use MCP servers with Pi — one proxy tool instead of hundreds";
    # Tarball hash (SRI). Get with: nix-prefetch-url https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-2.11.0.tgz
    hash = "sha256-fUVwNzZAxIpHK9HqbT+x9FEp3ZPGmi6//2dX4eEN0lk=";
    # Installed output hash (SRI). Set to lib.fakeSha256, build, use 'got:' from error.
    # This may shift when transitive deps publish new patches — one-line fix.
    npmDepsHash = "sha256-NKDCt4aTiOVu6DGJbhcp/Cahf6TFHBWa0wtRQDBY9n4=";
  };
}
