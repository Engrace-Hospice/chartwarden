import {
  Button,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  SelectField,
  StatusPill,
  type StatusTone,
  TextField,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
  useStaleSelection,
} from "@wardenx/ui";
// apps/admin/src/modules/34-saas-platform — Signup Intents queue (M34 Phase-3, §4.1 platform-ops; F02/ADR-0010).
// Spec: docs/modules/... §5.1 screen inventory. The pre-provision intake funnel a platform-ops actor
// triages: /signups lists the queue (GET /api/v1/platform/signup-intents); the right drawer (`?intent=<id>`) offers
// Qualify (`new → qualified` → enqueues `tenant.provision`, POST .../{id}/qualify) and Reject
// (`new → rejected` with a recorded rationale, POST .../{id}/reject). Live-wired over the typed
// client; imports only @wardenx/ui leaves + the Foundation tone map.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { SIGNUP_TONE, cap } from "./saas-status";

// §3.11 wire vocab mirror — the route returns these intent statuses.
type SignupIntentStatus = "new" | "qualified" | "provisioned" | "abandoned" | "rejected";
type SignupIntentSource = "self_serve_form" | "platform_ops_manual" | "partner_referral";
type PlanLabel = "starter" | "standard" | "enterprise";

const PLAN_OPTIONS: readonly { value: PlanLabel; label: string }[] = [
  { value: "starter", label: "Starter" },
  { value: "standard", label: "Standard" },
  { value: "enterprise", label: "Enterprise" },
];
const FIRST_ADMIN_NAME_MAX = 200;

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

interface Banner {
  tone: "success" | "error";
  text: string;
}

export function Signups(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("intent");
  const [intents, setIntents] = useState<SignupIntentView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const guard = useRequestGuard();
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<SignupIntentStatus | "all">("all");
  const [banner, setBanner] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/signup-intents");
    if (!isCurrent()) return;
    if (err) {
      setError("Could not load signup intents.");
      setLoaded(false);
      setLoading(false);
      return;
    }
    const page = (data ?? null) as CursorPage<SignupIntentView> | null;
    setIntents(page?.items ?? []);
    setLoaded(true);
    setLoading(false);
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeDrawer = (): void => setParams({});

  // Qualify enqueues the `tenant.provision` flow (§7.1); reject records the rationale on the intent.
  async function qualify(
    intent: SignupIntentView,
    firstAdminFullName: string,
    planLabel: PlanLabel,
  ): Promise<void> {
    setBusy(true);
    const { error: err } = await client.POST("/api/v1/platform/signup-intents/{id}/qualify", {
      params: { path: { id: intent.id } },
      body: { planLabel, firstAdminFullName: firstAdminFullName.trim() },
    });
    setBusy(false);
    if (err) {
      setBanner({ tone: "error", text: "Qualify failed." });
      return;
    }
    setBanner({ tone: "success", text: "Intent qualified — provisioning enqueued." });
    closeDrawer();
    void load();
  }

  async function reject(intent: SignupIntentView): Promise<void> {
    setBusy(true);
    const { error: err } = await client.POST("/api/v1/platform/signup-intents/{id}/reject", {
      params: { path: { id: intent.id } },
      // TODO(M34 web): this stub screen should collect the rejection reason from an operator input.
      body: { rejectionReason: "Rejected via platform console" },
    });
    setBusy(false);
    if (err) {
      setBanner({ tone: "error", text: "Reject failed." });
      return;
    }
    setBanner({ tone: "success", text: "Intent rejected." });
    closeDrawer();
    void load();
  }

  const visible =
    statusFilter === "all" ? intents : intents.filter((i) => i.intentStatus === statusFilter);
  const selected = selectedId ? intents.find((i) => i.id === selectedId) : undefined;
  useStaleSelection({ param: "intent", ready: loaded, found: selected !== undefined });

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Signup intents</h1>
            <p>The pre-provision intake funnel: qualify an intent to provision it, or reject it.</p>
          </div>
          <div className="wx-list-toolbar-end">
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
          </div>
        </header>

        {banner ? <InlineAlert tone={banner.tone}>{banner.text}</InlineAlert> : null}

        <IntentTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={(i) => setParams({ intent: i.id })}
          onRetry={() => void load()}
        />
      </div>
      {selected ? (
        <IntentDrawer
          key={selected.id}
          intent={selected}
          busy={busy}
          onClose={closeDrawer}
          onQualify={(firstAdminFullName, planLabel) =>
            void qualify(selected, firstAdminFullName, planLabel)
          }
          onReject={() => void reject(selected)}
        />
      ) : null}
    </div>
  );
}

function IntentTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: SignupIntentView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (i: SignupIntentView) => void;
  onRetry: () => void;
}): JSX.Element {
  if (error)
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">{error}</InlineAlert>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading signup intents…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="user-plus" size={24} />
        <span>No intents match this filter.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Signup intents</caption>
        <thead>
          <tr>
            <th scope="col">Business</th>
            <th scope="col">Source</th>
            <th scope="col">Received</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const isSelected = i.id === selectedId;
            const open = (): void => onSelect(i);
            return (
              <tr
                key={i.id}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(open, isSelected)}
              >
                <td>
                  <span className="wx-row-title">{i.legalBusinessName}</span>
                  <span className="wx-row-sub wx-data-md">{i.contactEmail}</span>
                </td>
                <td>{cap(i.source)}</td>
                <td className="wx-nums">{new Date(i.receivedAt).toLocaleString()}</td>
                <td>
                  <StatusPill label={cap(i.intentStatus)} tone={intentTone(i.intentStatus)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IntentDrawer({
  intent,
  busy,
  onClose,
  onQualify,
  onReject,
}: {
  intent: SignupIntentView;
  busy: boolean;
  onClose: () => void;
  onQualify: (firstAdminFullName: string, planLabel: PlanLabel) => void;
  onReject: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const actionable = intent.intentStatus === "new";
  const [firstAdminFullName, setFirstAdminFullName] = useState("");
  const [planLabel, setPlanLabel] = useState<PlanLabel>("standard");
  return (
    <aside className="wx-admission-drawer" aria-label="Signup intent" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="user-plus" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>{intent.legalBusinessName}</h2>
          <span className="wx-row-sub wx-data-md">{intent.id}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Intent</h3>
            <StatusPill label={cap(intent.intentStatus)} tone={intentTone(intent.intentStatus)} />
          </div>
          <dl className="wx-kv">
            <dt>Intent id</dt>
            <dd className="wx-data-md break-words">{intent.id}</dd>
            <dt>Contact email</dt>
            <dd className="wx-data-md break-words">{intent.contactEmail}</dd>
            <dt>Intended first admin</dt>
            <dd className="wx-data-md break-words">{intent.intendedFirstAdminEmail}</dd>
            <dt>Source</dt>
            <dd>{cap(intent.source)}</dd>
            <dt>Received</dt>
            <dd className="wx-nums">{new Date(intent.receivedAt).toLocaleString()}</dd>
            {intent.processedAt ? (
              <>
                <dt>Processed</dt>
                <dd className="wx-nums">{new Date(intent.processedAt).toLocaleString()}</dd>
              </>
            ) : null}
            {intent.rejectionReason ? (
              <>
                <dt>Rejection reason</dt>
                <dd className="break-words">{intent.rejectionReason}</dd>
              </>
            ) : null}
            {intent.tenantAccountId ? (
              <>
                <dt>Tenant account</dt>
                <dd className="wx-data-md break-words">{intent.tenantAccountId}</dd>
              </>
            ) : null}
          </dl>
        </section>

        {actionable ? (
          <section className="wx-drawer-card">
            <h3>Triage</h3>
            <TextField
              label="First admin full name"
              type="text"
              required
              maxLength={FIRST_ADMIN_NAME_MAX}
              autoComplete="name"
              value={firstAdminFullName}
              onChange={(event) => setFirstAdminFullName(event.target.value)}
            />
            <SelectField
              label="Plan"
              value={planLabel}
              options={PLAN_OPTIONS}
              onChange={(event) => setPlanLabel(event.target.value as PlanLabel)}
            />
            <div className="wx-drawer-actions">
              <Button
                onClick={() => onQualify(firstAdminFullName, planLabel)}
                disabled={busy || firstAdminFullName.trim().length === 0}
              >
                {busy ? "Working…" : "Qualify"}
              </Button>
              <Button tone="secondary" onClick={onReject} disabled={busy}>
                Reject
              </Button>
            </div>
          </section>
        ) : (
          <p className="wx-source-line">
            <Glyph name="info" size={14} />
            <span className="wx-source-text">
              This intent has been processed; no further triage actions are available.
            </span>
          </p>
        )}
      </div>
    </aside>
  );
}
