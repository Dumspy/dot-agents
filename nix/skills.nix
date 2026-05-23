# Skill registry: name -> source specification
# Consumed by packages.nix to build derivations and by home-manager modules
# to know which skills exist.
{externalSources}: let
  # Helper to reference a local skill
  local = path: {
    type = "local";
    inherit path;
  };

  # Helper to reference an external skill from a flake input
  external = input: subdir: name: {
    type = "external";
    path = input + "/${subdir}/${name}";
  };
in {
  # --- Local skills ---
  # Paths are relative to nix/skills.nix, so ../skills/ points to repo root skills/
  dependabot-solver = local ../skills/dependabot-solver;
  "pr-review-resolver" = local ../skills/pr-review-resolver;
  librarian = local ../skills/librarian;

  # --- Anthropic ---
  "skill-creator" = external externalSources.anthropics-agent-skills "skills" "skill-creator";

  # --- Agent Browser ---
  "agent-browser" = external externalSources.agent-browser "skills" "agent-browser";
}
