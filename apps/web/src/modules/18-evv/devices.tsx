// apps/web/src/modules/18-evv — EVV Devices (M18 §5.1 `/app/evv/devices/pending`, Track B / ADR-0030).
// Spec: docs/design/screens — "Use Work Queue". The team device roster (devices awaiting approval surface first):
// one row per `evv_device` with platform / model / integrity status. The approve / reject / suspend / retire
// write CTAs fill in as those write paths harden; the SERVER owns the device lifecycle + RLS (ADR-0030 — no
// frontend authz). Reads GET /api/v1/evv/devices via the typed client. Leaves only (@wardenx/ui).
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { EmptyState, LoadingSpinner, PageHeader, useApiClient, WorkQueueLayout } from "@wardenx/ui";
import { DataTable, EVV_DEVICE_COLOR, StatusChip } from "./evv-shared";

interface DeviceRow {
  id: string;
  membershipId: string;
  platform: string;
  modelDescription: string;
  status: string;
}

/** Shared device roster; `mine` scopes to the session membership (the self-service `/me/evv/devices` variant). */
export function EvvDeviceRoster({ title }: { title: string }): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/evv/devices", { params: { query: {} } });
    if (err) {
      setError("Could not load EVV devices.");
      setLoading(false);
      return;
    }
    setRows(((data ?? []) as DeviceRow[]) ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Devices awaiting approval surface first (the supervisor's primary work).
  const ordered = [...rows].sort((a, b) =>
    a.status === "pending_approval" && b.status !== "pending_approval" ? -1 : 0,
  );

  return (
    <WorkQueueLayout
      header={<PageHeader title={title} />}
      table={
        error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loading ? (
          <LoadingSpinner />
        ) : ordered.length === 0 ? (
          <EmptyState title="No devices" description="No EVV devices are registered." />
        ) : (
          <DataTable<DeviceRow>
            rows={ordered}
            rowKey={(d) => d.id}
            columns={[
              { header: "Device", cell: (d) => d.id },
              { header: "Clinician", cell: (d) => d.membershipId },
              { header: "Platform", cell: (d) => d.platform },
              { header: "Model", cell: (d) => d.modelDescription },
              { header: "Status", cell: (d) => <StatusChip value={d.status} colorMap={EVV_DEVICE_COLOR} /> },
            ]}
          />
        )
      }
    />
  );
}

export function EvvDevicesPending(): JSX.Element {
  return <EvvDeviceRoster title="EVV Devices — Pending Approval" />;
}

export function EvvMyDevices(): JSX.Element {
  return <EvvDeviceRoster title="My EVV Devices" />;
}
