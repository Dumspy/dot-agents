{pkgs, ...}: {
  packages = with pkgs; [
    nodejs
    git
    alejandra
  ];

  git-hooks.hooks.alejandra = {
    enable = true;
    excludes = [
      "^\\.devenv/"
      "^\\.direnv/"
      "^result$"
    ];
  };
}
