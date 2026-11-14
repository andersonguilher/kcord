// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminPanel } from "../src/hooks/useAdminPanel.ts";
import type { ClientReport } from "../src/types.ts";

const SEEN_KEY = "kafcord:client-reports-seen-at";

function report(id: string, at: string, status: ClientReport["status"] = "open"): ClientReport {
  return {
    id,
    at,
    kind: "microphone",
    message: `falha ${id}`,
    displayName: "Ana",
    client: "browser",
    appVersion: null,
    userAgent: "",
    context: {},
    status,
  };
}

const stats = { days: [], totals: {} };

let reports: ClientReport[];
let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

beforeEach(() => {
  localStorage.clear();
  reports = [report("a", "2026-11-10T10:00:00Z"), report("b", "2026-11-11T10:00:00Z"), report("c", "2026-11-12T10:00:00Z", "resolved")];
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/admin/stats")) return respond(stats);
    if (url === "/api/admin/client-reports") return respond({ reports });
    if (url.startsWith("/api/admin/client-reports/") && init?.method === "PATCH") {
      const { status } = JSON.parse(String(init.body));
      return respond({ report: { ...reports[0], status } });
    }
    return respond({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // Vitest globals are off, so Testing Library does not unmount hooks on its own.
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useAdminPanel", () => {
  it("makes no requests for users who cannot manage the community", async () => {
    const { result } = renderHook(() => useAdminPanel(false, vi.fn()));
    await act(async () => {
      await result.current.loadAdminStats();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.clientReports).toEqual([]);
  });

  it("loads reports on mount and counts them by status", async () => {
    const { result } = renderHook(() => useAdminPanel(true, vi.fn()));
    await waitFor(() => expect(result.current.clientReports).toHaveLength(3));
    expect(result.current.clientReportCounts).toEqual({ open: 2, resolved: 1, ignored: 0 });
    expect(result.current.unseenClientReports).toBe(2);
    expect(result.current.visibleClientReports.map((entry) => entry.id)).toEqual(["a", "b"]);

    act(() => result.current.setClientReportFilter("resolved"));
    expect(result.current.visibleClientReports.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("treats unknown statuses as open", async () => {
    reports = [{ ...report("x", "2026-11-12T10:00:00Z"), status: "weird" as ClientReport["status"] }];
    const { result } = renderHook(() => useAdminPanel(true, vi.fn()));
    await waitFor(() => expect(result.current.clientReports).toHaveLength(1));
    expect(result.current.clientReports[0].status).toBe("open");
  });

  it("marks reports as seen, and remembers it, once the panel is opened", async () => {
    const { result } = renderHook(() => useAdminPanel(true, vi.fn()));
    await waitFor(() => expect(result.current.unseenClientReports).toBe(2));
    act(() => result.current.setShowAdminStats(true));
    await waitFor(() => expect(result.current.unseenClientReports).toBe(0));
    expect(localStorage.getItem(SEEN_KEY)).toBe("2026-11-12T10:00:00Z");
  });

  it("starts from the stored seen marker", async () => {
    localStorage.setItem(SEEN_KEY, "2026-11-10T12:00:00Z");
    const { result } = renderHook(() => useAdminPanel(true, vi.fn()));
    await waitFor(() => expect(result.current.clientReports).toHaveLength(3));
    expect(result.current.unseenClientReports).toBe(1);
  });

  it("loads statistics together with the reports", async () => {
    const { result } = renderHook(() => useAdminPanel(true, vi.fn()));
    await act(async () => {
      await result.current.loadAdminStats();
    });
    expect(result.current.adminStats).toEqual(stats);
    expect(result.current.adminStatsError).toBe("");
    expect(result.current.adminStatsLoading).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/stats?days=30", { cache: "no-store" });
  });

  it("uses the selected range and reports server errors", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("/api/admin/stats") ? respond({ error: "Sem acesso" }, false) : respond({ reports }),
    );
    const { result } = renderHook(() => useAdminPanel(true, vi.fn()));
    act(() => result.current.setAdminStatsRange(7));
    await act(async () => {
      await result.current.loadAdminStats();
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/stats?days=7", { cache: "no-store" });
    expect(result.current.adminStatsError).toBe("Sem acesso");
    expect(result.current.adminStats).toBeNull();
  });

  it("polls statistics every 30 seconds only while the panel is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useAdminPanel(true, vi.fn()));
    const statsCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/admin/stats")).length;
    expect(statsCalls()).toBe(0);
    act(() => result.current.setShowAdminStats(true));
    await waitFor(() => expect(statsCalls()).toBe(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(statsCalls()).toBe(2);
    act(() => result.current.setShowAdminStats(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(statsCalls()).toBe(2);
  });

  it("changes a report status and reports failures through the notice", async () => {
    const setNotice = vi.fn();
    const { result } = renderHook(() => useAdminPanel(true, setNotice));
    await waitFor(() => expect(result.current.clientReports).toHaveLength(3));
    await act(async () => {
      await result.current.updateClientReportStatus("a", "ignored");
    });
    expect(result.current.clientReports.find((entry) => entry.id === "a")?.status).toBe("ignored");
    expect(result.current.updatingClientReportId).toBe("");

    fetchMock.mockImplementation(() => respond({ error: "Falhou" }, false));
    await act(async () => {
      await result.current.updateClientReportStatus("b", "resolved");
    });
    expect(setNotice).toHaveBeenCalledWith("Falhou");
    expect(result.current.clientReports.find((entry) => entry.id === "b")?.status).toBe("open");
  });

  it("announces a live report to the owner and refreshes the list", async () => {
    const setNotice = vi.fn();
    const { result } = renderHook(() => useAdminPanel(true, setNotice));
    await waitFor(() => expect(result.current.clientReports).toHaveLength(3));
    reports = [...reports, report("d", "2026-11-13T10:00:00Z")];
    await act(async () => {
      result.current.clientReportAlertRef.current({ displayName: "Bia", kind: "microphone", message: "x".repeat(300) });
    });
    expect(setNotice).toHaveBeenCalledTimes(1);
    const text = setNotice.mock.calls[0][0] as string;
    expect(text).toContain("Falha no app de Bia (Microfone):");
    expect(text.length).toBeLessThan(260);
    await waitFor(() => expect(result.current.clientReports).toHaveLength(4));
  });

  it("ignores live alerts for users who cannot manage the community", async () => {
    const setNotice = vi.fn();
    const { result } = renderHook(() => useAdminPanel(false, setNotice));
    await act(async () => {
      result.current.clientReportAlertRef.current({ displayName: "Bia", kind: "microphone", message: "x" });
    });
    expect(setNotice).not.toHaveBeenCalled();
  });
});
