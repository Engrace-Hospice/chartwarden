import {
  EmptyState,
  FilterBar,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/34-saas — Signup Intents queue (M34 Phase-3, §4.1 platform-ops; F02/ADR-0010).
// Spec: docs/modules/... §5.1 screen inventory. The pre-provision intake funnel a platform-ops actor
// triages: /signups lists the queue (GET /api/v1/platform/signup-intents); the detail panel offers
// Qualify (`new → qualified` → enqueues `tenant.provision`, POST .../{id}/qualify) and Reject
// (`new → rejected` with a recorded rationale, POST .../{id}/reject). Live-wired over the typed
// client; imports only @wardenx/ui leaves + the Foundation tone map.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { SIGNUP_TONE, cap } from "./saas-status";

// §3.11 wire vocab mirror — the route returns these intent statuses.
type SignupIntentStatus = "new" | "qualified" | "provisioned" | "abandoned" | "rejected";
type SignupIntentSource = "self_serve_form" | "platform_ops_manual" | "partner_referral";

interface SignupIntentView {
  id: string;
  contactEmail: string;
  legalBusinessName: string;
  intendedFirstAdminEmail: string;
  intentStatus: SignupIntentStatus;
  source: SignupIntentSource;
  rejectionReason: string | null;
  receivedAt: string;
  processedAt: string | null;
  tenantAccountId: string | null;
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// The Foundation SIGNUP_TONE covers new/qualified/rejected; provisioned/abandoned fall back here.
const EXTRA_TONE: Record<string, StatusTone> = {
  provisioned: "success",
  abandoned: "neutral",
};
function intentTone(status: string): StatusTone {
  return SIGNUP_TONE[status] ?? EXTRA_TONE[status] ?? "neutral";
}

const STATUS_FILTERS: readonly (SignupIntentStatus | "all")[] = [
  "all",
  "new",
  "qualified",
  "provisioned",
  "abandoned",
  "rejected",
];

export function Signups(): JSX.Element {
  const client = useApiClient();
  const [intents, setIntents] = useState<SignupIntentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<SignupIntentStatus | "all">("all");
  const [selected, setSelected] = useState<SignupIntentView | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/signup-intents");
    if (err) {
      setError("Could not load signup intents.");
      setLoading(false);
      return;
    }
    const page = (data ?? null) as CursorPage<SignupIntentView> | null;
    setIntents(page?.items ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Qualify enqueues the `tenant.provision` flow (§7.1); reject records the rationale on the intent.
  async function qualify(intent: SignupIntentView): Promise<void> {
    setBusy(true);
    const { error: err } = await client.POST("/api/v1/platform/signup-intents/{id}/qualify", {
      params: { path: { id: intent.id } },
    });
    setBusy(false);
    if (err) {
      setBanner("Qualify failed.");
      return;
    }
    setBanner("Intent qualified — provisioning enqueued.");
    setSelected(null);
    void load();
  }

  async function reject(intent: SignupIntentView): Promise<void> {
    setBusy(true);
    const { error: err } = await client.POST("/api/v1/platform/signup-intents/{id}/reject", {
      params: { path: { id: intent.id } },
    });
    setBusy(false);
    if (err) {
      setBanner("Reject failed.");
      return;
    }
    setBanner("Intent rejected.");
    setSelected(null);
    void load();
  }

  const visible =
    statusFilter === "all" ? intents : intents.filter((i) => i.intentStatus === statusFilter);

  return (
    <WorkQueueLayout
      header={<PageHeader title="Signup Intents" />}
      filters={
        <FilterBar>
          <select
            aria-label="Intent status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SignupIntentStatus | "all")}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : cap(s)}
              </option>
            ))}
          </select>
          {banner ? (
            <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
              {banner}
            </span>
          ) : null}
        </FilterBar>
      }
      table={
        <IntentTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      }
      detail={
        selected ? (
          <IntentDetail
            intent={selected}
            busy={busy}
            onClose={() => setSelected(null)}
            onQualify={() => void qualify(selected)}
            onReject={() => void reject(selected)}
          />
        ) : undefined
      }
    />
  );
}

function IntentTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: SignupIntentView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (i: SignupIntentView) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No signup intents" description="No intents match this filter." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Business</th>
            <th>Contact</th>
            <th>Source</th>
            <th>Received</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr
              key={i.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={i.id === selectedId}
              onClick={() => onSelect(i)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(i);
                }
              }}
              style={{
                cursor: "pointer",
                background: i.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td>{i.legalBusinessName}</td>
              <td className="wx-data-md">{i.contactEmail}</td>
              <td>{cap(i.source)}</td>
              <td className="tabular-nums">{new Date(i.receivedAt).toLocaleString()}</td>
              <td>
                <StatusPill label={cap(i.intentStatus)} tone={intentTone(i.intentStatus)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IntentDetail({
  intent,
  busy,
  onClose,
  onQualify,
  onReject,
}: {
  intent: SignupIntentView;
  busy: boolean;
  onClose: () => void;
  onQualify: () => void;
  onReject: () => void;
}): JSX.Element {
  const actionable = intent.intentStatus === "new";
  const row = (label: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</div>
      <div
        style={{ fontSize: "0.85rem", wordBreak: "break-word", color: "var(--color-on-surface)" }}
      >
        {value}
      </div>
    </div>
  );
  return (
    <RightDetailPanel title={intent.legalBusinessName} onClose={onClose}>
      {row("Intent id", <span className="wx-data-md">{intent.id}</span>)}
      {row(
        "Status",
        <StatusPill label={cap(intent.intentStatus)} tone={intentTone(intent.intentStatus)} />,
      )}
      {row("Contact email", <span className="wx-data-md">{intent.contactEmail}</span>)}
      {row(
        "Intended first admin",
        <span className="wx-data-md">{intent.intendedFirstAdminEmail}</span>,
      )}
      {row("Source", cap(intent.source))}
      {row(
        "Received",
        <span className="tabular-nums">{new Date(intent.receivedAt).toLocaleString()}</span>,
      )}
      {intent.processedAt
        ? row(
            "Processed",
            <span className="tabular-nums">{new Date(intent.processedAt).toLocaleString()}</span>,
          )
        : null}
      {intent.rejectionReason ? row("Rejection reason", intent.rejectionReason) : null}
      {intent.tenantAccountId
        ? row("Tenant account", <span className="wx-data-md">{intent.tenantAccountId}</span>)
        : null}

      {actionable ? (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            marginTop: "1rem",
            borderTop: "1px solid var(--color-outline-variant)",
            paddingTop: "1rem",
          }}
        >
          <button type="button" onClick={onQualify} disabled={busy}>
            {busy ? "Working…" : "Qualify"}
          </button>
          <button type="button" onClick={onReject} disabled={busy}>
            Reject
          </button>
        </div>
      ) : (
        <div
          style={{
            marginTop: "1rem",
            fontSize: "0.78rem",
            color: "var(--color-on-surface-variant)",
          }}
        >
          This intent has been processed; no further triage actions are available.
        </div>
      )}
    </RightDetailPanel>
  );
}
