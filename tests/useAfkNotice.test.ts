// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAfkNotice } from "../src/hooks/useAfkNotice.ts";

const HIDDEN_KEY = "kafcord:afk-dialog-hidden";

/** A storage whose reads and/or writes throw, like a browser with site data blocked. */
function stubBrokenStorage({ read, write }: { read: boolean; write: boolean }) {
  const fail = () => {
    throw new Error("storage unavailable");
  };
  vi.stubGlobal("localStorage", {
    getItem: read ? fail : () => null,
    setItem: write ? fail : () => undefined,
    removeItem: () => undefined,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useAfkNotice", () => {
  it("is closed until the server moves the member to the AFK channel", () => {
    const { result } = renderHook(() => useAfkNotice());
    expect(result.current.showAfkDialog).toBe(false);
    act(() => result.current.announceAfkMove());
    expect(result.current.showAfkDialog).toBe(true);
  });

  it("stays hidden for people who chose not to see it again", () => {
    localStorage.setItem(HIDDEN_KEY, "1");
    const { result } = renderHook(() => useAfkNotice());
    act(() => result.current.announceAfkMove());
    expect(result.current.showAfkDialog).toBe(false);
  });

  it("shows the dialog when storage cannot be read", () => {
    stubBrokenStorage({ read: true, write: false });
    const { result } = renderHook(() => useAfkNotice());
    act(() => result.current.announceAfkMove());
    expect(result.current.showAfkDialog).toBe(true);
  });

  it("closing with the X never saves the preference, even if the box is ticked", () => {
    const { result } = renderHook(() => useAfkNotice());
    act(() => result.current.announceAfkMove());
    act(() => result.current.setHideAfkDialogNextTime(true));
    act(() => result.current.closeAfkDialog());
    expect(result.current.showAfkDialog).toBe(false);
    expect(localStorage.getItem(HIDDEN_KEY)).toBeNull();
  });

  it("Ok closes without saving unless the box is ticked", () => {
    const { result } = renderHook(() => useAfkNotice());
    act(() => result.current.announceAfkMove());
    act(() => result.current.confirmAfkDialog());
    expect(result.current.showAfkDialog).toBe(false);
    expect(localStorage.getItem(HIDDEN_KEY)).toBeNull();
  });

  it("Ok with the box ticked saves it, and the next move stays silent", () => {
    const first = renderHook(() => useAfkNotice());
    act(() => first.result.current.announceAfkMove());
    act(() => first.result.current.setHideAfkDialogNextTime(true));
    act(() => first.result.current.confirmAfkDialog());
    expect(localStorage.getItem(HIDDEN_KEY)).toBe("1");
    first.unmount();

    const second = renderHook(() => useAfkNotice());
    act(() => second.result.current.announceAfkMove());
    expect(second.result.current.showAfkDialog).toBe(false);
  });

  it("still closes when the preference cannot be saved", () => {
    stubBrokenStorage({ read: false, write: true });
    const { result } = renderHook(() => useAfkNotice());
    act(() => result.current.announceAfkMove());
    act(() => result.current.setHideAfkDialogNextTime(true));
    expect(() => act(() => result.current.confirmAfkDialog())).not.toThrow();
    expect(result.current.showAfkDialog).toBe(false);
  });
});
