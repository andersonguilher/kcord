const { app } = require("electron");
const { uIOhook } = require("uiohook-napi");

let hookStarted = false;

app.whenReady().then(() => {
  uIOhook.start();
  hookStarted = true;
  setTimeout(() => {
    uIOhook.stop();
    hookStarted = false;
    console.log("Smoke test aprovado: hook global inicializado pelo Electron.");
    app.quit();
  }, 150);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on("before-quit", () => {
  if (hookStarted) uIOhook.stop();
});
