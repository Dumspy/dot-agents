{pkgs, ...}: {
  packages = with pkgs; [
    nodejs
    rsync
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

  enterShell = ''
    cd pi && npm install
  '';
}
