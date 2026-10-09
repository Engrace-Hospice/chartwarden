import {
  Button,
  EmptyState,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  SelectField,
  StatusPill,
  TextAreaField,
  TextField,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — the DDE work queue (ADR-0052): the Medicare Direct Data Entry (FISS)
// work a biller must key by hand — NOE/NOTR, claim entry, RTP corrections, adjustments, cancels, ADR responses. A
// worklist (patient · type · deadline · status) and a right rail for the selected item with the actions the server
// says are allowed now. HUMAN WORK TRACKING ONLY: WardenX never connects to DDE, so "recorded as keyed" is the
// operator's word, and recording it needs a fresh step-up. An NOE/NOTR is on time only once the MAC acceptance
// date is recorded; a keyed item with no acceptance date stays "at risk". No MBI is shown or accepted here; notes
// are never logged. 2026-09-25 redesign pattern (the admissions census + drawer); kit components and wx-* classes
// only. The server evaluates every rule and is the only authorization point (ADR-0030).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import {
  DEADLINE_LABEL,
  DEADLINE_TONE,
  type DdeEvent,
  type DdeItem,
  type DdeItemType,
  type DdeState,
  EVENT_LABEL,
  NOTES_MAX,
  type OutcomeDraft,
  STATE_LABEL,
  STATE_TONE,
  type SubmissionDraft,
  TYPE_LABEL,
  deadlineNote,
  errorCode,
  errorMessage,
  fmtDay,
  isNoticeType,
  validateOutcome,
  validateSubmission,
} from "./dde-queue-model";
import { authFailureRedirect } from "./write-workflow";

interface PatientName {
  firstName?: string | null;
  lastName?: string | null;
}

const STATE_FILTERS: { value: "" | DdeState; label: string }[] = [
  { value: "", label: "All" },
  ...(Object.keys(STATE_LABEL) as DdeState[]).map((s) => ({ value: s, label: STATE_LABEL[s] })),
];
const TYPE_FILTERS: { value: "" | DdeItemType; label: string }[] = [
  { value: "", label: "All types" },
  ...(Object.keys(TYPE_LABEL) as DdeItemType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] })),
];

const nameOf = (p: PatientName | undefined, id: string): string =>
  p && (p.firstName || p.lastName)
    ? [p.lastName, p.firstName].filter(Boolean).join(", ")
    : `Patient ${id.slice(0, 8)}`;

export function DdeQueue(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<DdeItem[]>([]);
  const [patients, setPatients] = useState<Record<string, PatientName>>({});
  const [state, setState] = useState<"" | DdeState>("");
  const [itemType, setItemType] = useState<"" | DdeItemType>("");
  const [overdue, setOverdue] = useState(false);
  const [atRisk, setAtRisk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const selectedId = params.get("item");

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the load after an action / "Try again".
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .GET("/api/v1/billing/dde-items", {
        params: {
          query: {
            limit: 100,
            ...(state ? { state } : {}),
            ...(itemType ? { itemType } : {}),
            ...(overdue ? { overdue: true } : {}),
            ...(atRisk ? { atRisk: true } : {}),
          },
        },
      })
      .then(({ data, error: err }) => {
        if (!active) return;
        if (err || !data) {
          setError("The DDE queue could not be loaded. You may lack billing scope.");
          setItems([]);
        } else setItems(data.items as DdeItem[]);
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setError("The DDE queue could not be loaded. Check your connection.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, state, itemType, overdue, atRisk, reloadKey]);

  useEffect(() => {
    const missing = [...new Set(items.map((n) => n.patientId))].filter((id) => !patients[id]);
    if (missing.length === 0) return;
    let active = true;
    void Promise.all(
      missing.map(async (id) => {
        const r = await client.GET("/api/v1/patients/{id}", { params: { path: { id } } });
        return [id, (r.data as PatientName | undefined) ?? {}] as const;
      }),
    )
      .then((pairs) => {
        if (active) setPatients((prev) => ({ ...prev, ...Object.fromEntries(pairs) }));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, items, patients]);

  const selected = useMemo(
    () => items.find((n) => n.ddeWorkItemId === selectedId) ?? null,
    [items, selectedId],
  );
  const select = (id: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id) next.set("item", id);
        else next.delete("item");
        return next;
      },
      { replace: true },
    );
  const overdueCount = items.filter((i) => i.deadlineStatus === "overdue").length;
  const atRiskCount = items.filter((i) => i.deadlineStatus === "at_risk").length;

  return (
    <div className={`wx-admissions${selected ? " has-drawer" : ""}`}>
      <div className="wx-admissions-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>DDE Work Queue</h1>
            <p>
              Medicare Direct Data Entry work to key by hand. WardenX does not connect to DDE:
              record what you keyed and what came back. A notice is on time only once the MAC
              acceptance date is recorded.
            </p>
          </div>
        </header>

        <BillingTabs />

        <div className="wx-filter-panel">
          <label className="wx-filter-field">
            <span>Status</span>
            <select
              className="wx-select"
              aria-label="Status"
              value={state}
              onChange={(e) => setState(e.target.value as "" | DdeState)}
            >
              {STATE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wx-filter-field">
            <span>Type</span>
            <select
              className="wx-select"
              aria-label="Type"
              value={itemType}
              onChange={(e) => setItemType(e.target.value as "" | DdeItemType)}
            >
              {TYPE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wx-filter-field">
            <span>Overdue only</span>
            <input
              type="checkbox"
              aria-label="Overdue only"
              checked={overdue}
              onChange={(e) => setOverdue(e.target.checked)}
            />
          </label>
          <label className="wx-filter-field">
            <span>At risk only</span>
            <input
              type="checkbox"
              aria-label="At risk only"
              checked={atRisk}
              onChange={(e) => setAtRisk(e.target.checked)}
            />
          </label>
          <p className="wx-row-sub" aria-live="polite">
            {loading
              ? "Loading…"
              : `${items.length} items · ${overdueCount} overdue · ${atRiskCount} at risk`}
          </p>
        </div>

        {error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="DDE queue unavailable" description={error} />
            <button type="button" className="wx-btn-secondary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title="No DDE work"
              description="Items appear here when a notice nears its filing window or when someone queues DDE work."
            />
          </div>
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table">
              <caption className="wx-sr-only">DDE work items</caption>
              <thead>
                <tr>
                  <th scope="col">Patient</th>
                  <th scope="col">Work</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((n) => {
                  const isSelected = n.ddeWorkItemId === selectedId;
                  return (
                    <tr
                      key={n.ddeWorkItemId}
                      className={
                        isSelected
                          ? "is-selected wx-data-row-interactive"
                          : "wx-data-row-interactive"
                      }
                      {...interactiveRowProps(() => select(n.ddeWorkItemId), isSelected, true)}
                    >
                      <td>
                        <span className="wx-row-title">
                          {nameOf(patients[n.patientId], n.patientId)}
                        </span>
                        <span className="wx-row-sub">
                          {n.assigneeMembershipId ? "Assigned" : "Unassigned"}
                          {n.attemptNumber > 1 ? ` · attempt ${n.attemptNumber}` : ""}
                        </span>
                      </td>
                      <td>{TYPE_LABEL[n.itemType]}</td>
                      <td>
                        <span className="wx-nums">{fmtDay(n.deadlineAt)}</span>
                        {n.deadlineStatus !== "none" ? (
                          <StatusPill
                            label={DEADLINE_LABEL[n.deadlineStatus]}
                            tone={DEADLINE_TONE[n.deadlineStatus]}
                          />
                        ) : null}
                      </td>
                      <td>
                        <StatusPill label={STATE_LABEL[n.state]} tone={STATE_TONE[n.state]} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selected ? (
        <ItemRail
          key={`${selected.ddeWorkItemId}:${selected.version}`}
          item={selected}
          patientName={nameOf(patients[selected.patientId], selected.patientId)}
          onClose={() => select(null)}
          onChanged={reload}
        />
      ) : null}
    </div>
  );
}

type Panel = "none" | "submit" | "outcome";

function ItemRail({
  item: n,
  patientName,
  onClose,
  onChanged,
}: {
  item: DdeItem;
  patientName: string;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [panel, setPanel] = useState<Panel>("none");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [events, setEvents] = useState<DdeEvent[]>([]);
  const can = (a: DdeItem["allowedActions"][number]) => n.allowedActions.includes(a);
  const note = deadlineNote(n);
  // Each click is one request; a fresh key per click, so a retried network call is deduplicated server-side.
  const params = () => ({
    path: { id: n.ddeWorkItemId },
    header: {
      "Idempotency-Key":
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
    },
  });

  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/billing/dde-items/{id}", { params: { path: { id: n.ddeWorkItemId } } })
      .then(({ data }) => {
        if (active && data) setEvents((data.events ?? []) as DdeEvent[]);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, n.ddeWorkItemId]);

  /** Run one POST; route auth failures (step-up included), surface the server's refusal inline, refresh. */
  const run = async (
    call: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
    fallback: string,
  ): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const { error, response } = await call();
      if (error) {
        const redirect = authFailureRedirect(
          response?.status,
          errorCode(error),
          `${location.pathname}${location.search}`,
        );
        if (redirect) {
          navigate(redirect);
          return;
        }
        setActionError(
          response?.status === 412
            ? "This item changed since you opened it. It has been reloaded; try again."
            : errorMessage(error, fallback),
        );
        if (response?.status === 412) onChanged();
        return;
      }
      setPanel("none");
      onChanged();
    } catch {
      setActionError(`${fallback} Check your connection.`);
    } finally {
      setBusy(false);
    }
  };
  const simple = (
    kind: "claim" | "start" | "retry" | "cancel" | "close",
    fallback: string,
  ): Promise<void> => {
    const call = () => {
      const args = { params: params(), body: { expectedVersion: n.version } };
      switch (kind) {
        case "claim":
          return client.POST("/api/v1/billing/dde-items/{id}/claim", args);
        case "start":
          return client.POST("/api/v1/billing/dde-items/{id}/start", args);
        case "retry":
          return client.POST("/api/v1/billing/dde-items/{id}/retry", args);
        case "cancel":
          return client.POST("/api/v1/billing/dde-items/{id}/cancel", args);
        case "close":
          return client.POST("/api/v1/billing/dde-items/{id}/close", args);
      }
    };
    return run(call, fallback);
  };

  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={`DDE work for ${patientName}`}>
      <header className="wx-drawer-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <h2>{patientName}</h2>
            <StatusPill label={STATE_LABEL[n.state]} tone={STATE_TONE[n.state]} />
          </div>
          <div className="wx-row-sub" style={{ fontSize: "0.8125rem" }}>
            {TYPE_LABEL[n.itemType]} · attempt {n.attemptNumber}
          </div>
        </div>
        <button type="button" className="wx-icon-link" aria-label="Close details" onClick={onClose}>
          <Glyph name="close" size={18} />
        </button>
      </header>
      <nav className="wx-detail-tabs" aria-label="Item views">
        <span aria-current="page">DDE item</span>
        <Link to={`/patients/${n.patientId}/claims`}>Claims</Link>
        {isNoticeType(n.itemType) ? <Link to="/billing/noe">Notices</Link> : null}
      </nav>

      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <h3>Work item</h3>
          <dl className="wx-kv">
            <Row term="Deadline">
              <span className="wx-nums">{fmtDay(n.deadlineAt)}</span>
              {n.deadlineStatus !== "none" ? (
                <StatusPill
                  label={DEADLINE_LABEL[n.deadlineStatus]}
                  tone={DEADLINE_TONE[n.deadlineStatus]}
                />
              ) : null}
            </Row>
            {note ? (
              <Row term="Note">
                <span className="wx-row-sub">{note}</span>
              </Row>
            ) : null}
            <Row term="Keyed in DDE">{n.submittedAt ? fmtDay(n.submittedAt) : "Not yet"}</Row>
            <Row term="MAC accepted on">{fmtDay(n.macAcceptedOn)}</Row>
            <Row term="DCN / ICN">
              <span className="wx-nums">{n.dcn ?? "—"}</span>
            </Row>
            {n.rtpReasonCode ? (
              <Row term="RTP reason code">
                <span className="wx-nums">{n.rtpReasonCode}</span>
              </Row>
            ) : null}
            <Row term="Source">
              {n.source === "watchdog" ? "Filing-window watch" : "Added by staff"}
            </Row>
            {n.notes ? <Row term="Notes">{n.notes}</Row> : null}
          </dl>
        </section>

        <section className="wx-drawer-card" aria-label="History">
          <h3>History</h3>
          {events.length === 0 ? (
            <p className="wx-row-sub">No history loaded.</p>
          ) : (
            <ul className="wx-checklist">
              {events.map((e) => (
                <li key={e.eventId}>
                  <span className="wx-check-box" aria-hidden />
                  <span style={{ flex: 1 }}>
                    {EVENT_LABEL[e.event] ?? e.event}
                    <span className="wx-row-sub wx-nums">{fmtDay(e.occurredAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {n.allowedActions.length > 0 ? (
          <section className="wx-drawer-card" aria-label="Actions">
            <h3>Actions</h3>
            {actionError ? <InlineAlert>{actionError}</InlineAlert> : null}
            {panel === "submit" ? (
              <SubmissionForm
                busy={busy}
                onCancel={() => setPanel("none")}
                onSubmit={(d) =>
                  run(
                    () =>
                      client.POST("/api/v1/billing/dde-items/{id}/record-submission", {
                        params: params(),
                        body: {
                          expectedVersion: n.version,
                          ...(d.dcn ? { dcn: d.dcn } : {}),
                          ...(d.notes ? { notes: d.notes } : {}),
                        },
                      }),
                    "That could not be recorded.",
                  )
                }
              />
            ) : panel === "outcome" ? (
              <OutcomeForm
                item={n}
                busy={busy}
                onCancel={() => setPanel("none")}
                onSubmit={(d) =>
                  run(
                    () =>
                      client.POST("/api/v1/billing/dde-items/{id}/record-outcome", {
                        params: params(),
                        body: {
                          expectedVersion: n.version,
                          outcome: d.outcome as "accepted" | "returned",
                          ...(d.macAcceptedOn ? { macAcceptedOn: d.macAcceptedOn } : {}),
                          ...(d.rtpReasonCode ? { rtpReasonCode: d.rtpReasonCode } : {}),
                          ...(d.dcn ? { dcn: d.dcn } : {}),
                          ...(d.notes ? { notes: d.notes } : {}),
                        },
                      }),
                    "The outcome could not be recorded.",
                  )
                }
              />
            ) : (
              <div className="wx-action-row">
                {can("claim") ? (
                  <Button
                    disabled={busy}
                    onClick={() => simple("claim", "You could not take this item.")}
                  >
                    Take it
                  </Button>
                ) : null}
                {can("start") ? (
                  <Button
                    disabled={busy}
                    onClick={() => simple("start", "The item could not be started.")}
                  >
                    Start work
                  </Button>
                ) : null}
                {can("record_submission") ? (
                  <Button disabled={busy} onClick={() => setPanel("submit")}>
                    Record as keyed in DDE
                  </Button>
                ) : null}
                {can("record_outcome") ? (
                  <Button disabled={busy} onClick={() => setPanel("outcome")}>
                    Record what came back
                  </Button>
                ) : null}
                {can("retry") ? (
                  <Button
                    disabled={busy}
                    onClick={() => simple("retry", "The item could not be reopened.")}
                  >
                    Reopen as a new attempt
                  </Button>
                ) : null}
                {can("close") ? (
                  <Button
                    tone="secondary"
                    disabled={busy}
                    onClick={() => simple("close", "The item could not be closed.")}
                  >
                    Close
                  </Button>
                ) : null}
                {can("cancel") ? (
                  <Button
                    tone="tertiary"
                    disabled={busy}
                    onClick={() => simple("cancel", "The item could not be cancelled.")}
                  >
                    Cancel item
                  </Button>
                ) : null}
              </div>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

function FormFooter({
  busy,
  label,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  label: string;
  onCancel: () => void;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <div className="wx-action-row is-end">
      <Button tone="tertiary" disabled={busy} onClick={onCancel}>
        Back
      </Button>
      <Button disabled={busy} onClick={onSubmit}>
        {busy ? "Working…" : label}
      </Button>
    </div>
  );
}

const NOTES_HINT = `Optional, up to ${NOTES_MAX} characters. Never enter the Medicare number (MBI).`;

function SubmissionForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (d: SubmissionDraft) => void;
}): JSX.Element {
  const [d, setD] = useState<SubmissionDraft>({ dcn: "", notes: "" });
  const [errors, setErrors] = useState<Partial<Record<keyof SubmissionDraft, string>>>({});
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <p className="wx-row-sub">
        This records that you keyed the item in DDE. WardenX cannot check it, so it is your word and
        it is audited. It needs a recent re-authentication.
      </p>
      <TextField
        label="DCN / ICN / receipt number"
        hint="Optional. As DDE shows it."
        maxLength={23}
        value={d.dcn}
        error={errors.dcn}
        onChange={(e) => setD({ ...d, dcn: e.target.value.trim() })}
      />
      <TextAreaField
        label="Notes"
        hint={NOTES_HINT}
        rows={3}
        maxLength={NOTES_MAX}
        value={d.notes}
        error={errors.notes}
        onChange={(e) => setD({ ...d, notes: e.target.value })}
      />
      <FormFooter
        busy={busy}
        label="Record as keyed"
        onCancel={onCancel}
        onSubmit={() => {
          const e = validateSubmission(d);
          setErrors(e);
          if (Object.keys(e).length === 0) onSubmit(d);
        }}
      />
    </div>
  );
}

function OutcomeForm({
  item,
  busy,
  onCancel,
  onSubmit,
}: {
  item: DdeItem;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (d: OutcomeDraft) => void;
}): JSX.Element {
  const [d, setD] = useState<OutcomeDraft>({
    outcome: "",
    macAcceptedOn: "",
    rtpReasonCode: "",
    dcn: item.dcn ?? "",
    notes: "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof OutcomeDraft, string>>>({});
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <SelectField
        label="What came back"
        required
        value={d.outcome}
        error={errors.outcome}
        options={[
          { value: "", label: "Select…" },
          { value: "accepted", label: "Accepted by the MAC" },
          { value: "returned", label: "Returned / rejected" },
        ]}
        onChange={(e) => setD({ ...d, outcome: e.target.value as OutcomeDraft["outcome"] })}
      />
      {d.outcome === "accepted" ? (
        <TextField
          label="MAC acceptance date"
          type="date"
          required={isNoticeType(item.itemType)}
          hint={
            isNoticeType(item.itemType)
              ? "The date DDE shows. The notice is treated as accepted on this date."
              : "Optional. The date DDE shows."
          }
          value={d.macAcceptedOn}
          error={errors.macAcceptedOn}
          onChange={(e) => setD({ ...d, macAcceptedOn: e.target.value })}
        />
      ) : null}
      {d.outcome === "returned" ? (
        <TextField
          label="RTP reason code"
          required
          maxLength={8}
          value={d.rtpReasonCode}
          error={errors.rtpReasonCode}
          onChange={(e) => setD({ ...d, rtpReasonCode: e.target.value.toUpperCase().trim() })}
        />
      ) : null}
      <TextField
        label="DCN / ICN / receipt number"
        hint="Optional."
        maxLength={23}
        value={d.dcn}
        error={errors.dcn}
        onChange={(e) => setD({ ...d, dcn: e.target.value.trim() })}
      />
      <TextAreaField
        label="Notes"
        hint={NOTES_HINT}
        rows={3}
        maxLength={NOTES_MAX}
        value={d.notes}
        error={errors.notes}
        onChange={(e) => setD({ ...d, notes: e.target.value })}
      />
      <FormFooter
        busy={busy}
        label="Record outcome"
        onCancel={onCancel}
        onSubmit={() => {
          const e = validateOutcome(d, item);
          setErrors(e);
          if (Object.keys(e).length === 0) onSubmit(d);
        }}
      />
    </div>
  );
}
