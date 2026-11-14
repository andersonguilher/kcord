import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The browser build is installable as a webapp; the desktop clients ship their own shell.
const isDesktopClient = "kafcordDesktop" in window || "__TAURI_INTERNALS__" in window;
if (import.meta.env.PROD && !isDesktopClient && "serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
