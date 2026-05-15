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
  "frontend-design" = external externalSources.anthropics-agent-skills "skills" "frontend-design";

  # --- Vercel ---
  "react-best-practices" = external externalSources.vercel-agent-skills "skills" "react-best-practices";
  "web-design-guidelines" = external externalSources.vercel-agent-skills "skills" "web-design-guidelines";

  # --- Agent Browser ---
  "agent-browser" = external externalSources.agent-browser "skills" "agent-browser";

  # --- Dex ---
  "dex" = external externalSources.dex-agent-skills "plugins/dex/skills" "dex";
  "dex-plan" = external externalSources.dex-agent-skills "plugins/dex/skills" "dex-plan";

  # --- Sentry ---
  "doc-coauthoring" = external externalSources.sentry-skills "skills" "doc-coauthoring";
}
