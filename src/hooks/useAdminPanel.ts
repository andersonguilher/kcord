import { useCallback, useEffect, useRef, useState } from "react";
import { clientReportLabels, normalizeClientReports } from "../lib/clientReports";
import type { AdminStats, ClientReport, ClientReportKind, ClientReportStatus } from "../types";

/**
 * Owner-only admin panel: server traffic statistics and the client failure
 * reports sent by the apps. `canManage` gates every request; `setNotice` shows
 * the alert when a report arrives while the owner is online.
 */
export function useAdminPanel(canManage: boolean, setNotice: (text: string) => void) {
  const [showAdminStats, setShowAdminStats] = useState(false);
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);
  const [adminStatsRange, setAdminStatsRange] = useState(30);
  const [adminStatsLoading, setAdminStatsLoading] = useState(false);
  const [adminStatsError, setAdminStatsError] = useState("");
  const [clientReports, setClientReports] = useState<ClientReport[]>([]);
  const [clientReportFilter, setClientReportFilter] = useState<ClientReportStatus>("open");
  const [updatingClientReportId, setUpdatingClientReportId] = useState("");
  const [clientReportsSeenAt, setClientReportsSeenAt] = useState(() => {
    try {
      return localStorage.getItem("kafcord:client-reports-seen-at") ?? "";
    } catch {
      return "";
    }
  });
  const clientReportAlertRef = useRef<(report: { displayName: string; kind: ClientReportKind; message: string }) => void>(() => undefined);

  const loadAdminStats = useCallback(async () => {
    if (!canManage) return;
    setAdminStatsLoading(true);
    setAdminStatsError("");
    try {
      const response = await fetch(`/api/admin/stats?days=${adminStatsRange}`, { cache: "no-store" });
      const result = await response.json() as AdminStats & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Não foi possível carregar as estatísticas.");
      setAdminStats(result);
      const reportsResponse = await fetch("/api/admin/client-reports", { cache: "no-store" });
      if (reportsResponse.ok) setClientReports(normalizeClientReports((await reportsResponse.json() as { reports: ClientReport[] }).reports));
    } catch (error) {
      setAdminStatsError(error instanceof Error ? error.message : "Não foi possível carregar as estatísticas.");
    } finally {
      setAdminStatsLoading(false);
    }
  }, [adminStatsRange, canManage]);

  const loadClientReports = useCallback(async () => {
    if (!canManage) return;
    try {
      const response = await fetch("/api/admin/client-reports", { cache: "no-store" });
      if (response.ok) setClientReports(normalizeClientReports((await response.json() as { reports: ClientReport[] }).reports));
    } catch {
      // The badge just stays as it was.
    }
  }, [canManage]);

  useEffect(() => {
    void loadClientReports();
  }, [loadClientReports]);

  clientReportAlertRef.current = (report) => {
    if (!canManage) return;
    setNotice(`Falha no app de ${report.displayName} (${clientReportLabels[report.kind] ?? report.kind}): ${report.message.slice(0, 160)}`);
    void loadClientReports();
  };

  const updateClientReportStatus = async (id: string, status: ClientReportStatus) => {
    if (updatingClientReportId) return;
    setUpdatingClientReportId(id);
    try {
      const response = await fetch(`/api/admin/client-reports/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = await response.json() as { report?: ClientReport; error?: string };
      if (!response.ok || !result.report) throw new Error(result.error ?? "Não foi possível alterar o relatório.");
      const updated = normalizeClientReports([result.report])[0];
      setClientReports((current) => current.map((report) => report.id === id ? updated : report));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Não foi possível alterar o relatório.");
    } finally {
      setUpdatingClientReportId("");
    }
  };

  const unseenClientReports = clientReports.filter((report) => report.status === "open" && report.at > clientReportsSeenAt).length;
  const visibleClientReports = clientReports.filter((report) => report.status === clientReportFilter);
  const clientReportCounts = {
    open: clientReports.filter((report) => report.status === "open").length,
    resolved: clientReports.filter((report) => report.status === "resolved").length,
    ignored: clientReports.filter((report) => report.status === "ignored").length,
  };
  useEffect(() => {
    if (!showAdminStats || clientReports.length === 0) return;
    const newest = clientReports.reduce((latest, report) => report.at > latest ? report.at : latest, clientReports[0].at);
    setClientReportsSeenAt(newest);
    try {
      localStorage.setItem("kafcord:client-reports-seen-at", newest);
    } catch {
      // The badge comes back after a reload; nothing else depends on it.
    }
  }, [clientReports, showAdminStats]);

  useEffect(() => {
    if (!showAdminStats || !canManage) return undefined;
    void loadAdminStats();
    const timer = window.setInterval(() => void loadAdminStats(), 30_000);
    return () => window.clearInterval(timer);
  }, [canManage, loadAdminStats, showAdminStats]);

  return {
    showAdminStats,
    setShowAdminStats,
    adminStats,
    adminStatsRange,
    setAdminStatsRange,
    adminStatsLoading,
    adminStatsError,
    loadAdminStats,
    clientReports,
    clientReportFilter,
    setClientReportFilter,
    updatingClientReportId,
    updateClientReportStatus,
    unseenClientReports,
    visibleClientReports,
    clientReportCounts,
    clientReportAlertRef,
  };
}
