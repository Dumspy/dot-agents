# MCP server the librarian agent uses to fetch and read dependency source.
{
  lib,
  buildNpmPackage,
  fetchFromGitHub,
  nodejs_22,
}:
buildNpmPackage {
  pname = "opensrc-mcp";
  version = "0.3.0";

  src = fetchFromGitHub {
    owner = "dmmulroy";
    repo = "opensrc-mcp";
    rev = "v0.3.0";
    hash = "sha256-g9fAW8jCKPcNVujsn1bDxJtc2lJmr0Vv6ANcL/Uwr1s=";
  };

  npmDepsHash = "sha256-nFds8MSZld/mV8bqeCRDvP2i1+FMnRxLapHJafeW/ew=";

  nodejs = nodejs_22;

  meta = {
    description = "MCP server for fetching and querying dependency source code";
    license = lib.licenses.mit;
    mainProgram = "opensrc-mcp";
  };
}
