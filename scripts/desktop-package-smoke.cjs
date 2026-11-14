const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const archive = path.resolve(process.argv[2] || "desktop-dist/win-unpacked/resources/app.asar");
const rootPackageJson = require("../package.json");
const packageJson = JSON.parse(asar.extractFile(archive, "package.json"));
const main = asar.extractFile(archive, "main.cjs").toString();
const instanceLock = asar.extractFile(archive, "instance-lock.cjs").toString();
const pttHook = asar.extractFile(archive, "ptt-hook.cjs").toString();
const packagedFiles = asar.listPackage(archive);

assert.equal(packageJson.version, rootPackageJson.version);
assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ["electron-updater", "koffi", "uiohook-napi"]);
for (const forbiddenPackage of ["express", "react", "react-dom", "socket.io", "socket.io-client", "tsx"]) {
  assert.equal(
    packagedFiles.some((file) => file.startsWith(`\\node_modules\\${forbiddenPackage}\\`)),
    false,
    `${forbiddenPackage} não deve ser incluído no aplicativo desktop.`,
  );
}

assert.match(main, /process\.argv\.includes\("--updated"\)/);
assert.match(instanceLock, /maxRetries = 20/);
assert.match(instanceLock, /retryDelayMs = 500/);
assert.match(main, /ipcMain\.handle\("ptt:learn"/);
assert.match(main, /ipcMain\.handle\("autostart:set"/);
assert.match(main, /page-title-updated/);
assert.match(main, /ipcMain\.handle\("ptt:diagnostics"/);
assert.match(pttHook, /hook = null/);
assert.match(main, /ipcMain\.handle\("desktop-share:snapshot"/);
assert.match(main, /isTrustedIpcEvent/);
assert.match(main, /ipcMain\.on\("overlay:state"/);
assert.match(main, /autoUpdater\.disableWebInstaller = false/);
assert.match(asar.extractFile(archive, "ptt-poll.cjs").toString(), /GetAsyncKeyState/);
assert.match(asar.extractFile(archive, "window-list.cjs").toString(), /EnumWindows/);
assert.match(main, /ipcMain\.handle\("app-audio:start"/);
assert.match(asar.extractFile(archive, "app-audio.cjs").toString(), /--include/);
assert.match(asar.extractFile(archive, "window-state.cjs").toString(), /window-state\.json/);
const appAudioHelper = path.join(path.dirname(archive), "bin", "kcord-app-audio.exe");
assert.ok(fs.statSync(appAudioHelper).size > 0, "Captura de áudio do aplicativo ausente do pacote.");

const unpacked = `${archive}.unpacked/node_modules/koffi/build/koffi`;
assert.deepEqual(fs.readdirSync(unpacked), ["win32_x64"]);
const uiohookPrebuilds = `${archive}.unpacked/node_modules/uiohook-napi/prebuilds`;
assert.deepEqual(fs.readdirSync(uiohookPrebuilds), ["win32-x64"]);

const localesDirectory = path.join(path.dirname(path.dirname(archive)), "locales");
assert.deepEqual(fs.readdirSync(localesDirectory).sort(), ["en-US.pak", "pt-BR.pak"]);

console.log(`Smoke test aprovado: pacote ${packageJson.version} contém somente dependências desktop, dois idiomas e fronteira IPC protegida.`);
