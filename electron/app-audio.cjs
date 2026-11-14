// Shares the audio of the shared app only, like Discord: a small native helper
// (native/app-audio) records one process tree with the Windows process loopback
// API. A full-screen share records every app except KCord, so viewers do not hear
// their own voices back. Needs Windows 10 2004 or newer; otherwise the page falls
// back to the system loopback.

const { recordIssue } = require("./desktop-issues.cjs");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BYTES_PER_FRAME = 8; // 32-bit float, stereo
const READY_TIMEOUT_MS = 8_000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 300;

function helperPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", "kcord-app-audio.exe")
    : path.join(__dirname, "..", "native", "app-audio", "target", "release", "kcord-app-audio.exe");
}

function createAppAudio({ app, windowProcessId }) {
  let active = null;

  function stop() {
    const current = active;
    active = null;
    if (!current) return;
    current.stopped = true;
    const child = current.child;
    // The helper never started (spawn failed): there is nothing to close.
    if (!child) return;
    child.stdin?.end();
    // The helper exits as soon as stdin closes; make sure it does.
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1_500).unref();
  }

  function start(sourceId, webContents) {
    stop();
    if (process.platform !== "win32") return Promise.resolve({ ok: false, error: "Disponível somente no Windows." });
    const executable = helperPath(app);
    if (!fs.existsSync(executable)) return Promise.resolve({ ok: false, error: "Captura de áudio do aplicativo não instalada." });

    let args;
    if (sourceId.startsWith("screen:")) {
      args = ["--exclude", String(process.pid)];
    } else {
      const processId = windowProcessId(sourceId);
      if (!processId || processId === process.pid) return Promise.resolve({ ok: false, error: "Aplicativo não encontrado." });
      args = ["--include", String(processId)];
    }

    const capture = { child: null, stopped: false };
    active = capture;

    return new Promise((resolve) => {
      let settled = false;
      // Restarts after the helper is killed from outside (antivirus, anti-cheat…).
      const restartTimes = [];
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!result.ok && active === capture) stop();
        resolve(result);
      };
      const timer = setTimeout(() => settle({ ok: false, error: "O Windows não iniciou a captura de áudio a tempo." }), READY_TIMEOUT_MS);

      function launch() {
        let child;
        try {
          child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        } catch (error) {
          // Windows can refuse to start the helper (antivirus, Smart App Control, blocked file).
          settle({ ok: false, error: `O Windows bloqueou o auxiliar de áudio (${error.message}).` });
          return;
        }
        capture.child = child;
        let ready = false;
        let status = "";
        // Unexpected helper output, kept to explain an exit that sent no "error" line.
        let lastOutput = "";
        // The helper prints "ended" when the shared app's process closed: expected, not a failure.
        let targetEnded = false;
        let pending = Buffer.alloc(0);

        child.on("error", (error) => settle({ ok: false, error: error.message }));
        // These streams are null when the process failed to start.
        if (!child.stdin || !child.stdout || !child.stderr) return;
        child.stdin.on("error", () => undefined);
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (text) => {
          status += text;
          let newline;
          while ((newline = status.indexOf("\n")) >= 0) {
            const line = status.slice(0, newline).trim();
            status = status.slice(newline + 1);
            if (line === "ready") {
              ready = true;
              settle({ ok: true });
            } else if (line === "ended") targetEnded = true;
            else if (line.startsWith("error")) settle({ ok: false, error: line.slice(5).trim() || "Falha na captura de áudio." });
            else if (line) lastOutput = line.slice(0, 200);
          }
        });
        child.stdout.on("data", (chunk) => {
          if (capture.stopped || webContents.isDestroyed()) return;
          const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          const usable = data.length - (data.length % BYTES_PER_FRAME);
          pending = data.subarray(usable);
          if (usable > 0) webContents.send("app-audio:data", new Uint8Array(data.buffer, data.byteOffset, usable));
        });
        child.on("exit", (code, signal) => {
          if (capture.child !== child) return;
          // 0xC0000135 means a DLL is missing; 0xC0000005 is a crash; 0x40010004 means
          // something terminated the helper.
          const exitCode = code === null ? signal : `0x${(code >>> 0).toString(16).toUpperCase()}`;
          const reason = `A captura de áudio foi encerrada (código ${exitCode}${lastOutput ? `: ${lastOutput}` : ""}; ${args[0].slice(2)}).`;
          if (ready && !capture.stopped && !targetEnded && !webContents.isDestroyed()) {
            // Like Discord: bring the audio back quietly, a few times per minute at most.
            const now = Date.now();
            while (restartTimes.length && now - restartTimes[0] > RESTART_WINDOW_MS) restartTimes.shift();
            if (restartTimes.length < MAX_RESTARTS) {
              restartTimes.push(now);
              setTimeout(() => {
                if (active === capture && !capture.stopped) launch();
              }, RESTART_DELAY_MS).unref();
              return;
            }
          }
          if (ready && !capture.stopped && !targetEnded) recordIssue("som só do aplicativo parou durante a live", new Error(reason));
          settle({ ok: false, error: reason });
          if (active === capture) active = null;
          if (!capture.stopped && !webContents.isDestroyed()) webContents.send("app-audio:ended");
        });
      }

      launch();
    });
  }

  return { start, stop };
}

module.exports = { createAppAudio };
