// apps/web/src/modules/41-billing-commercial — CLEARINGHOUSE ENROLLMENT REPORTS on the enrollments screen (M41, migration 1323).
//   GET  /api/v1/billing/commercial/enrollment-reports?providerEntityId&state=open   the open reports (no patient data)
//   POST /api/v1/billing/commercial/enrollment-reports/{id}/resolve                  applied | dismissed (manage_enrollment)
// A report is ADVISORY: "Claim.MD reports enrolled (era) — confirm". Confirm opens the ordinary enrollment form pre-filled; only
// the user's own submit (with its step-up) records anything, and the report is closed `applied` after that. Dismiss closes it.
// Only the vendor's one bounded status word is shown, never its free text.
import { Button, InlineAlert, useApiClient, useToast } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { type EnrollmentReportView, enrollmentReportLine } from "./commercial-model";

export type ReportsLoad =
  | { readonly status: "loading" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly key: string;
      readonly items: readonly EnrollmentReportView[];
    };

/** The open reports of `entityId`; `reloadKey` re-reads them. */
export function useEnrollmentReports(entityId: string, reloadKey: number): ReportsLoad {
  const client = useApiClient();
  const [load, setLoad] = useState<ReportsLoad>({ status: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a retry trigger, not a value the effect reads.
  useEffect(() => {
    if (!entityId) return;
    let active = true;
    void client
      .GET("/api/v1/billing/commercial/enrollment-reports", {
        params: { query: { providerEntityId: entityId, state: "open" } },
      })
      .then(({ data, error }) => {
        if (active)
          setLoad(
            error || !data
              ? { status: "error" }
              : { status: "ready", key: entityId, items: data.items },
          );
      })
      .catch(() => {
        if (active) setLoad({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [client, entityId, reloadKey]);
  return load.status === "ready" && load.key !== entityId ? { status: "loading" } : load;
}

/** Close a report; resolves true when the server accepted it. */
export async function resolveEnrollmentReport(
  client: ReturnType<typeof useApiClient>,
  providerEntityId: string,
  id: string,
  resolution: "applied" | "dismissed",
): Promise<boolean> {
  try {
    const { error } = await client.POST(
      "/api/v1/billing/commercial/enrollment-reports/{id}/resolve",
      {
        params: { path: { id } },
        body: { providerEntityId, resolution },
      },
    );
    return !error;
  } catch {
    return false;
  }
}

export function EnrollmentReportsPanel({
  load,
  entityId,
  canManage,
  payerName,
  onConfirm,
  onChanged,
}: {
  load: ReportsLoad;
  entityId: string;
  canManage: boolean;
  payerName: (payerId: string) => string;
  onConfirm: (report: EnrollmentReportView) => void;
  onChanged: () => void;
}): JSX.Element | null {
  const client = useApiClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  if (load.status === "loading") return null;
  if (load.status === "error") {
    return (
      <InlineAlert tone="error">
        The clearinghouse enrollment reports could not be loaded.{" "}
        <Button tone="tertiary" size="sm" onClick={onChanged}>
          Try again
        </Button>
      </InlineAlert>
    );
  }
  if (load.items.length === 0) return null;

  const dismiss = async (r: EnrollmentReportView): Promise<void> => {
    setBusy(r.id);
    const ok = await resolveEnrollmentReport(client, entityId, r.id, "dismissed");
    setBusy(null);
    toast.show(ok ? "Report dismissed." : "The report could not be dismissed. Try again.", {
      tone: ok ? "success" : "error",
    });
    onChanged();
  };

  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption>
          Clearinghouse reports to confirm. Nothing changes until you confirm one and save the
          enrollment yourself.
        </caption>
        <thead>
          <tr>
            <th scope="col">Report</th>
            <th scope="col">Payer</th>
            <th scope="col">Reported</th>
            {canManage ? (
              <th scope="col">
                <span className="wx-sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {load.items.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="wx-row-title">{enrollmentReportLine(r)}</span>
              </td>
              <td>
                {r.payerId
                  ? payerName(r.payerId)
                  : `Payer id ${r.clearinghousePayerId ?? "not reported"}`}
              </td>
              <td className="wx-nums">{r.reportedAt.slice(0, 10)}</td>
              {canManage ? (
                <td>
                  <Button
                    tone="secondary"
                    size="sm"
                    aria-label={`Confirm: ${enrollmentReportLine(r)}`}
                    onClick={() => onConfirm(r)}
                    disabled={busy === r.id}
                  >
                    Confirm
                  </Button>{" "}
                  <Button
                    tone="tertiary"
                    size="sm"
                    aria-label={`Dismiss: ${enrollmentReportLine(r)}`}
                    onClick={() => void dismiss(r)}
                    disabled={busy === r.id}
                  >
                    Dismiss
                  </Button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
