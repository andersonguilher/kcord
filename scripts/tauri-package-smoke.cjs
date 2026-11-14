const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const bridge = fs.readFileSync(path.join(root, "src-tauri", "bridge.js"), "utf8");
const rustMain = fs.readFileSync(path.join(root, "src-tauri", "src", "main.rs"), "utf8");
const capability = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "capabilities", "remote-main.json"), "utf8"));
const releaseDir = path.join(root, "src-tauri", "target", "release");
const bundleDir = path.join(releaseDir, "bundle", "nsis");
const executable = path.join(releaseDir, "kcord-tauri.exe");

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(tauriConfig.version === packageJson.version, "Tauri and npm versions must match");
check(tauriConfig.build.frontendDist === "https://kafcord.kafly.com.br", "Tauri must load the production HTTPS origin");
check(tauriConfig.bundle.targets.includes("nsis"), "Tauri must create an NSIS installer");
check(capability.remote?.urls?.length === 2, "Remote capability must remain restricted to the two approved origins");
check(capability.remote?.urls?.includes("https://kafcord.kafly.com.br/*"), "Production origin is missing from the capability");
check(!capability.remote?.urls?.some((url) => url.includes("*://") || url === "*"), "Remote capability must not use a wildcard origin");
check(bridge.includes('captureMode: "system-picker"'), "Tauri bridge must use the protected system picker");
check(bridge.includes('id: "system-picker"'), "Tauri bridge must retain compatibility with the deployed frontend");
check(rustMain.includes('windows_subsystem = "windows"'), "Release binary must not open a Windows console");
check(fs.existsSync(executable), "Release executable not found; run npm run tauri:build first");

let installer;
if (fs.existsSync(bundleDir)) {
  installer = fs.readdirSync(bundleDir)
    .filter((name) => name.endsWith("-setup.exe"))
    .map((name) => path.join(bundleDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)[0];
}
check(Boolean(installer), "NSIS installer not found; run npm run tauri:build first");

const mebibytes = (bytes) => bytes / 1024 / 1024;
if (fs.existsSync(executable)) {
  const executableBytes = fs.readFileSync(executable);
  const peOffset = executableBytes.readUInt32LE(0x3c);
  const subsystem = executableBytes.readUInt16LE(peOffset + 24 + 68);
  check(subsystem === 2, `Release executable must use the Windows GUI subsystem; found ${subsystem}`);
  check(mebibytes(executableBytes.length) < 20, "Release executable unexpectedly exceeds 20 MiB");
}
if (installer) {
  check(mebibytes(fs.statSync(installer).size) < 10, "NSIS installer unexpectedly exceeds 10 MiB");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Tauri executable: ${mebibytes(fs.statSync(executable).size).toFixed(2)} MiB`);
  console.log(`Tauri installer: ${mebibytes(fs.statSync(installer).size).toFixed(2)} MiB`);
  console.log("Tauri package smoke test passed.");
}
