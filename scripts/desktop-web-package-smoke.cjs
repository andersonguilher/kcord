const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const output = path.join(root, "desktop-web-dist", "nsis-web");
const installer = path.join(output, `KCord-Web-Setup-${packageJson.version}.exe`);
const packages = fs.existsSync(output)
  ? fs.readdirSync(output).filter((name) => name.endsWith(".nsis.7z"))
  : [];

assert.equal(fs.existsSync(installer), true, "Instalador web ausente; execute npm run desktop:web-dist.");
assert.equal(packages.length, 1, "O build deve gerar exatamente um pacote .nsis.7z para x64.");

const installerMiB = fs.statSync(installer).size / 1024 / 1024;
const packageMiB = fs.statSync(path.join(output, packages[0])).size / 1024 / 1024;
assert.ok(installerMiB < 10, `O bootstrap excedeu 10 MiB (${installerMiB.toFixed(2)} MiB).`);
assert.ok(packageMiB > 50 && packageMiB < 150, `Tamanho inesperado do pacote (${packageMiB.toFixed(2)} MiB).`);

const latest = fs.readFileSync(path.join(output, "latest.yml"), "utf8");
assert.match(latest, new RegExp(`KCord-Web-Setup-${packageJson.version.replaceAll(".", "\\.")}\\.exe`));
assert.match(latest, /sha512:/);

console.log(`Instalador web: ${installerMiB.toFixed(2)} MiB`);
console.log(`Pacote baixado durante a instalação: ${packageMiB.toFixed(2)} MiB`);
console.log("Smoke test aprovado: bootstrap pequeno e pacote Electron íntegro.");
