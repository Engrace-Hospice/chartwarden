// apps/web/src/modules/04-audit — the staff amendment inbox (§164.526): pending requests with their 60-day
// due date, accept / deny. Deny requires a reason (server: 1-500 chars) and opens the statement-of-
// disagreement window. `GET /api/v1/amendments?status=pending` is the M5 staff list route (patient.amend_review);
// it is not yet in the generated client schema, so the read goes through a narrow local call shape.
import {
  Button,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  TextAreaField,
  useApiClient,
} from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

export interface PendingAmendment {
  id: string;
  patientId: string;
  status: string;
  scope?: string;
  rationale?: string;
  receivedAt?: string;
  slaDueAt: string;
}

interface LooseListClient {
  GET(
    path: string,
    init: { params: { query: Record<string, string> } },
  ): Promise<{ data?: { amendments?: PendingAmendment[] }; error?: unknown }>;
}

const DENIAL_REASON_MAX_CHARS = 500;
const DUE_SOON_DAYS = 14;
const DAY_MS = 24 * 3600 * 1000;

function formatDate(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "—";
}

/** Whole days until `slaDueAt` (negative once overdue). */
export function daysUntil(slaDueAt: string, now: Date): number {
  return Math.ceil((Date.parse(slaDueAt) - now.getTime()) / DAY_MS);
}

function dueTone(days: number): "neutral" | "warning" | "error" {
  if (days < 0) return "error";
  return days <= DUE_SOON_DAYS ? "warning" : "neutral";
}

export function AmendmentInbox(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<PendingAmendment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denyingId, setDenyingId] = useState<string | null>(null);
  const [denialReason, setDenialReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await (client as unknown as LooseListClient).GET(
      "/api/v1/amendments",
      { params: { query: { status: "pending" } } },
    );
    if (err) {
      setError("Could not load amendment requests.");
      setRows([]);
      return;
    }
    setError(null);
    setRows(data?.amendments ?? []);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, body: { denialReason: string } | null): Promise<void> {
    setBusyId(id);
    setError(null);
    const typed = client as ApiClient;
    const { error: err } = body
      ? await typed.POST("/api/v1/amendments/{id}/deny", { params: { path: { id } }, body })
      : await typed.POST("/api/v1/amendments/{id}/accept", { params: { path: { id } } });
    setBusyId(null);
    if (err) {
      setError(body ? "Could not deny the amendment." : "Could not accept the amendment.");
      return;
    }
    setDenyingId(null);
    setDenialReason("");
    await load();
  }

  if (rows === null) return <LoadingSpinner />;
  const now = new Date();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {error ? <InlineAlert>{error}</InlineAlert> : null}
      {rows.length === 0 ? (
        <EmptyState
          title="No pending amendment requests"
          description="Patient amendment requests appear here as soon as they are submitted."
        />
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.75rem" }}>
          {rows.map((a) => {
            const days = daysUntil(a.slaDueAt, now);
            return (
              <li key={a.id} className="wx-drawer-card">
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}>
                  <div>
                    <strong>{a.scope ? `${a.scope} amendment` : "Amendment request"}</strong>
                    <div className="wx-row-sub">
                      Received {formatDate(a.receivedAt)} · Due {formatDate(a.slaDueAt)}
                    </div>
                  </div>
                  <StatusPill
                    label={days < 0 ? `${-days}d overdue` : `${days}d left`}
                    tone={dueTone(days)}
                  />
                </div>
                {a.rationale ? <p>{a.rationale}</p> : null}
                {denyingId === a.id ? (
                  <form
                    className="wx-action-body is-flush"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void decide(a.id, { denialReason: denialReason.trim() });
                    }}
                  >
                    <TextAreaField
                      label="Denial reason"
                      required
                      rows={2}
                      maxLength={DENIAL_REASON_MAX_CHARS}
                      value={denialReason}
                      onChange={(e) => setDenialReason(e.target.value)}
                    />
                    <div className="wx-action-row is-end">
                      <Button type="button" tone="tertiary" onClick={() => setDenyingId(null)}>
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={denialReason.trim().length === 0}
                        loading={busyId === a.id}
                      >
                        Confirm denial
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="wx-action-row is-end">
                    <Button type="button" tone="secondary" onClick={() => setDenyingId(a.id)}>
                      Deny
                    </Button>
                    <Button
                      type="button"
                      loading={busyId === a.id}
                      onClick={() => void decide(a.id, null)}
                    >
                      Accept
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
