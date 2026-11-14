import { useCallback, useState } from "react";

const AFK_DIALOG_HIDDEN_KEY = "kafcord:afk-dialog-hidden";

/**
 * The "Olá, alguém aí?" dialog shown after the server moves an idle member to
 * the AFK channel, with a "don't show again" choice kept in localStorage.
 */
export function useAfkNotice() {
  const [showAfkDialog, setShowAfkDialog] = useState(false);
  const [hideAfkDialogNextTime, setHideAfkDialogNextTime] = useState(false);

  /** Opens the dialog, unless the person asked not to see it again. */
  const announceAfkMove = useCallback(() => {
    let dialogHidden = false;
    try {
      dialogHidden = localStorage.getItem(AFK_DIALOG_HIDDEN_KEY) === "1";
    } catch {
      dialogHidden = false;
    }
    if (!dialogHidden) setShowAfkDialog(true);
  }, []);

  const closeAfkDialog = useCallback(() => setShowAfkDialog(false), []);

  /** "Ok": remembers the "don't show again" choice, then closes. */
  const confirmAfkDialog = useCallback(() => {
    if (hideAfkDialogNextTime) {
      try {
        localStorage.setItem(AFK_DIALOG_HIDDEN_KEY, "1");
      } catch {
        // Shown again next time if storage is unavailable.
      }
    }
    setShowAfkDialog(false);
  }, [hideAfkDialogNextTime]);

  return { showAfkDialog, hideAfkDialogNextTime, setHideAfkDialogNextTime, announceAfkMove, closeAfkDialog, confirmAfkDialog };
}
