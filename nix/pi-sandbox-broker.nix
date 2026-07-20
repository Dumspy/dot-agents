{
  pkgs,
  piNodeModules,
}:
pkgs.stdenvNoCC.mkDerivation {
  name = "dot-agents-pi-sandbox-broker";
  src = ../pi;

  nativeBuildInputs = [pkgs.nodejs];

  buildPhase = ''
    runHook preBuild

    cp -r $src/. .
    chmod -R u+w .
    ln -s ${piNodeModules}/node_modules node_modules
    node node_modules/typescript/bin/tsc -p tsconfig.broker.json

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/libexec/sandbox-broker
    cp -r dist/sandbox-broker/. $out/libexec/sandbox-broker/
    ln -s ${piNodeModules}/node_modules $out/libexec/sandbox-broker/node_modules

    runHook postInstall
  '';
}
