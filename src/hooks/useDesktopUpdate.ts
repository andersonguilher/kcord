import { useEffect, useState, type RefObject } from "react";
import { installDesktopUpdate } from "../lib/session";

/** Seconds shown before a downloaded update restarts the app on its own. */
const RESTART_COUNTDOWN_SECONDS = 12;

/**
 * Status of the Windows app's auto-updater. Once an update is downloaded, a
 * countdown restarts the app to install it, keeping the current voice room so
 * the call resumes afterwards. `voiceChannelRef` always holds that room.
 */
export function useDesktopUpdate(voiceChannelRef: RefObject<string | null>) {
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateStatus | null>(null);
  const [restartCountdown, setRestartCountdown] = useState(RESTART_COUNTDOWN_SECONDS);

  useEffect(() => {
    const desktopBridge = window.kafcordDesktop;
    if (!desktopBridge) return;
    let active = true;
    void desktopBridge.getUpdateStatus().then((status) => {
      if (active && !["idle", "checking", "development"].includes(status.state)) setDesktopUpdate(status);
    });
    const unsubscribe = desktopBridge.onUpdateStatus((status) => {
      if (active) setDesktopUpdate(status);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (desktopUpdate?.state !== "downloaded") {
      setRestartCountdown(RESTART_COUNTDOWN_SECONDS);
      return;
    }
    let remaining = RESTART_COUNTDOWN_SECONDS;
    setRestartCountdown(remaining);
    const timer = window.setInterval(() => {
      remaining -= 1;
      setRestartCountdown(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
        installDesktopUpdate(voiceChannelRef.current);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [desktopUpdate?.state, voiceChannelRef]);

  return { desktopUpdate, setDesktopUpdate, restartCountdown };
}
