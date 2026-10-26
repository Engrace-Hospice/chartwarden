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
} from "@chartwarden/ui";
// apps/web/src/modules/23-billing-medicare — Transfer notices: the receiving hospice's Medicare Change of
// Provider / Transfer Notice (TOB 81C), its date correction and its 8xD void (CMS Pub. 100-04 ch. 11 §20.1.3 /
// §20.1.4). A worklist (patient · transfer date · notice · transferring hospice · status) and a right rail for
// the selected notice: what holds it, its derived codes, and the actions the server says are allowed now —
// confirm the transferring hospice finalized its billing, submit, correct the date, void, cancel, redraft.
// 2026-09-25 redesign pattern (the admissions census + drawer); kit components and wx-* classes only. The
// server evaluates every rule and is the only authorization point (ADR-0030).
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { BillingTabs } from "../../shell/billing-tabs";
import {
  ACTION_LABEL,
  type ConfirmDraft,
  type NoticeState,
  PATIENT_STATUS_OPTIONS,
  STATE_LABEL,
  type TransferNotice,
  errorCode,
  errorMessage,
  fmtDay,
  statusOf,
  validateConfirm,
  validateCorrection,
} from "./transfer-notice-model";
import { useAttemptKey } from "./use-attempt-key";
import { authFailureRedirect } from "./write-workflow";

interface PatientName {
  firstName?: string | null;
  lastName?: string | null;
  mrn?: string | null;
}

const STATE_FILTERS: { value: "" | NoticeState; label: string }[] = [
  { value: "", label: "All" },
  ...(Object.keys(STATE_LABEL) as NoticeState[]).map((s) => ({ value: s, label: STATE_LABEL[s] })),
];

const nameOf = (p: PatientName | undefined, id: string): string =>
  p && (p.firstName || p.lastName)
    ? [p.lastName, p.firstName].filter(Boolean).join(", ")
    : `Patient ${id.slice(0, 8)}`;

export function TransferNotices(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const [items, setItems] = useState<TransferNotice[]>([]);
  const [patients, setPatients] = useState<Record<string, PatientName>>({});
  const [state, setState] = useState<"" | NoticeState>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const selectedId = params.get("notice");

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey re-runs the load after an action / "Try again".
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void client
      .GET("/api/v1/billing/transfer-notices", {
        params: { query: { limit: 200, ...(state ? { state } : {}) } },
      })
      .then(({ data, error: err }) => {
        if (!active) return;
        if (err || !data) {
          setError("Transfer notices could not be loaded. You may lack billing scope.");
          setItems([]);
        } else setItems(data.items as TransferNotice[]);
        setLoading(false);
      })
      .catch(() => {
        if (active) {
          setError("Transfer notices could not be loaded. Check your connection.");
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, state, reloadKey]);

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
    () => items.find((n) => n.transferNoticeId === selectedId) ?? null,
    [items, selectedId],
  );
  const select = (id: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id) next.set("notice", id);
        else next.delete("notice");
        return next;
      },
      { replace: true },
    );
  const held = items.filter(
    (n) => (n.state === "draft" || n.state === "ready") && n.blockers.length > 0,
  ).length;

  return (
    <div className={`wx-admissions${selected ? " has-drawer" : ""}`}>
      <div className="wx-admissions-main">
        <header className="wx-page-head">
          <div>
            <h1 style={{ fontSize: "1.875rem" }}>Transfer Notices</h1>
            <p>
              The Medicare change-of-hospice notice (TOB 81C) for each patient transferred in, held
              until the transferring hospice has finalized its billing.
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
              onChange={(e) => setState(e.target.value as "" | NoticeState)}
            >
              {STATE_FILTERS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <p className="wx-row-sub" aria-live="polite">
            {loading ? "Loading…" : `${items.length} notices · ${held} held or blocked`}
          </p>
        </div>

        {error ? (
          <div className="wx-list-state" role="alert">
            <EmptyState title="Transfer notices unavailable" description={error} />
            <button type="button" className="wx-btn-secondary" onClick={reload}>
              Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <div className="wx-list-state">
            <EmptyState
              title="No transfer notices"
              description="A notice is drafted when a transfer-in is recorded on an admission."
            />
          </div>
        ) : (
          <div className="wx-list-table-wrap">
            <table className="wx-list-table">
              <caption className="wx-sr-only">Transfer notices</caption>
              <thead>
                <tr>
                  <th scope="col">Patient</th>
                  <th scope="col">Transfer date</th>
                  <th scope="col">Notice</th>
                  <th scope="col">Transferring hospice</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((n) => {
                  const isSelected = n.transferNoticeId === selectedId;
                  const status = statusOf(n);
                  return (
                    <tr
                      key={n.transferNoticeId}
                      className={
                        isSelected
                          ? "is-selected wx-data-row-interactive"
                          : "wx-data-row-interactive"
                      }
                      {...interactiveRowProps(() => select(n.transferNoticeId), isSelected, true)}
                    >
                      <td>
                        <span className="wx-row-title">
                          {nameOf(patients[n.patientId], n.patientId)}
                        </span>
                        <span className="wx-row-sub">Benefit period {n.benefitPeriodSequence}</span>
                      </td>
                      <td className="wx-nums">{fmtDay(n.statementFromDate)}</td>
                      <td>
                        {ACTION_LABEL[n.action]}
                        <span className="wx-row-sub wx-nums">TOB {n.tob}</span>
                      </td>
                      <td>
                        {n.priorHospiceName}
                        <span className="wx-row-sub wx-nums">
                          {n.priorHospiceCcn ? `CCN ${n.priorHospiceCcn}` : "CCN not recorded"}
                        </span>
                      </td>
                      <td>
                        <StatusPill label={status.label} tone={status.tone} />
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
        <NoticeRail
          key={`${selected.transferNoticeId}:${selected.version}`}
          notice={selected}
          patientName={nameOf(patients[selected.patientId], selected.patientId)}
          onClose={() => select(null)}
          onChanged={(next) => {
            if (next) select(next);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

type Panel = "none" | "confirm" | "correct" | "cancel";

function NoticeRail({
  notice: n,
  patientName,
  onClose,
  onChanged,
}: {
  notice: TransferNotice;
  patientName: string;
  onClose: () => void;
  onChanged: (selectId?: string) => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [panel, setPanel] = useState<Panel>("none");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const status = statusOf(n);
  const can = (a: TransferNotice["allowedActions"][number]) => n.allowedActions.includes(a);
  // A retry of the same request after a lost response reuses its key; any HTTP answer or changed input mints a new one.
  const attempt = useAttemptKey();
  const params = (key: string) => ({
    path: { id: n.transferNoticeId },
    header: { "Idempotency-Key": key },
  });

  /** Run one POST; route auth failures, surface the server's refusal inline, refresh on success. */
  const run = async (
    fingerprint: string,
    call: (key: string) => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
    fallback: string,
  ): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const { data, error, response } = await attempt.run(
        `${n.transferNoticeId}|${n.version}|${fingerprint}`,
        call,
      );
      if (error) {
        const code = errorCode(error);
        const redirect = authFailureRedirect(
          response?.status,
          code,
          `${location.pathname}${location.search}`,
        );
        if (redirect) {
          navigate(redirect);
          return;
        }
        setActionError(
          response?.status === 412
            ? "This notice changed since you opened it. It has been reloaded; try again."
            : errorMessage(error, fallback),
        );
        if (response?.status === 412) onChanged();
        return;
      }
      setPanel("none");
      const created = (data as { transferNoticeId?: string } | undefined)?.transferNoticeId;
      onChanged(created && created !== n.transferNoticeId ? created : undefined);
    } catch {
      setActionError(`${fallback} Check your connection.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className="wx-admission-drawer"
      {...drawer}
      aria-label={`Transfer notice for ${patientName}`}
    >
      <header className="wx-drawer-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <h2>{patientName}</h2>
            <StatusPill label={status.label} tone={status.tone} />
          </div>
          <div className="wx-row-sub" style={{ fontSize: "0.8125rem" }}>
            {ACTION_LABEL[n.action]} · TOB {n.tob} · {fmtDay(n.statementFromDate)}
          </div>
        </div>
        <button type="button" className="wx-icon-link" aria-label="Close details" onClick={onClose}>
          <Glyph name="close" size={18} />
        </button>
      </header>
      <nav className="wx-detail-tabs" aria-label="Notice views">
        <span aria-current="page">Notice</span>
        <Link to={`/admissions/${n.admissionId}`}>Admission</Link>
        <Link to={`/patients/${n.patientId}/claims`}>Claims</Link>
      </nav>

      <div className="wx-drawer-body">
        {n.state === "draft" || n.state === "ready" ? (
          <section className="wx-drawer-card" aria-label="Before it can be filed">
            <h3>Before it can be filed</h3>
            {n.blockers.length === 0 ? (
              <InlineAlert tone="success">Every transfer-notice rule passes.</InlineAlert>
            ) : (
              <ul className="wx-checklist">
                {n.blockers.map((b) => (
                  <li key={b.code}>
                    <span className="wx-check-box" aria-hidden />
                    <span style={{ flex: 1 }}>
                      {b.message}
                      <span className="wx-row-sub">{b.citation}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {n.warnings.map((w) => (
              <InlineAlert key={w.code} tone="info">
                {w.message}
              </InlineAlert>
            ))}
          </section>
        ) : null}

        <section className="wx-drawer-card">
          <h3>Notice</h3>
          <dl className="wx-kv">
            <Row term="Transfer date (From)">{fmtDay(n.statementFromDate)}</Row>
            {n.originalTransferDate ? (
              <Row term="Date being corrected">{fmtDay(n.originalTransferDate)}</Row>
            ) : null}
            <Row term="Our admission date">{fmtDay(n.admissionDate)}</Row>
            <Row term="Benefit period">
              {n.benefitPeriodSequence}
              {n.benefitPeriodStartDate ? `, from ${fmtDay(n.benefitPeriodStartDate)}` : ""}
            </Row>
            <Row term="Transferring hospice">{n.priorHospiceName}</Row>
            <Row term="Their CCN / NPI">
              {n.priorHospiceCcn ?? "—"} / {n.priorHospiceNpi ?? "—"}
            </Row>
            <Row term="Their final claim">
              {n.priorHospiceThroughDate
                ? `Through ${fmtDay(n.priorHospiceThroughDate)}, status ${n.priorHospicePatientStatus}`
                : "Not confirmed"}
            </Row>
            <Row term="Codes">
              {[
                ...n.occurrenceCodes.map((o) => `OC ${o.code} (${fmtDay(o.date)})`),
                ...n.conditionCodes.map((c) => `CC ${c}`),
              ].join(" · ") || "None"}
            </Row>
            <Row term="Control number">
              <span className="wx-nums">{n.controlNumber}</span>
            </Row>
            {n.payerControlNumber ? (
              <Row term="Payer control number">
                <span className="wx-nums">{n.payerControlNumber}</span>
              </Row>
            ) : null}
            {n.cancelReason ? <Row term="Cancelled because">{n.cancelReason}</Row> : null}
            {n.followUp ? (
              <Row term={n.followUp.action === "void" ? "Void" : "Correction"}>
                {STATE_LABEL[n.followUp.state]}
              </Row>
            ) : null}
          </dl>
        </section>

        {n.allowedActions.length > 0 ? (
          <section className="wx-drawer-card" aria-label="Actions">
            <h3>Actions</h3>
            {actionError ? <InlineAlert>{actionError}</InlineAlert> : null}
            {panel === "confirm" ? (
              <ConfirmForm
                notice={n}
                busy={busy}
                onCancel={() => setPanel("none")}
                onSubmit={(d) =>
                  run(
                    `confirm-prior-billing|${JSON.stringify(d)}`,
                    (key) =>
                      client.POST("/api/v1/billing/transfer-notices/{id}/confirm-prior-billing", {
                        params: params(key),
                        body: {
                          expectedVersion: n.version,
                          priorHospiceThroughDate: d.throughDate,
                          priorHospicePatientStatus: d.patientStatus as "50" | "51",
                          ...(d.ccn ? { priorHospiceCcn: d.ccn } : {}),
                          ...(d.npi ? { priorHospiceNpi: d.npi } : {}),
                        },
                      }),
                    "The confirmation could not be saved.",
                  )
                }
              />
            ) : panel === "correct" ? (
              <CorrectForm
                onFile={n.statementFromDate}
                busy={busy}
                onCancel={() => setPanel("none")}
                onSubmit={(date) =>
                  run(
                    `correct-date|${date}`,
                    (key) =>
                      client.POST("/api/v1/billing/transfer-notices/{id}/correct-date", {
                        params: params(key),
                        body: { correctedTransferDate: date },
                      }),
                    "The correction could not be drafted.",
                  )
                }
              />
            ) : panel === "cancel" ? (
              <CancelForm
                busy={busy}
                onCancel={() => setPanel("none")}
                onSubmit={(reason) =>
                  run(
                    `cancel|${reason}`,
                    (key) =>
                      client.POST("/api/v1/billing/transfer-notices/{id}/cancel", {
                        params: params(key),
                        body: { expectedVersion: n.version, reason },
                      }),
                    "The notice could not be cancelled.",
                  )
                }
              />
            ) : (
              <div className="wx-action-row">
                {can("submit") ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(
                        "submit",
                        (key) =>
                          client.POST("/api/v1/billing/transfer-notices/{id}/submit", {
                            params: params(key),
                            body: { expectedVersion: n.version },
                          }),
                        "The notice could not be submitted.",
                      )
                    }
                  >
                    Submit to Medicare
                  </Button>
                ) : null}
                {can("confirm_prior_billing") ? (
                  <Button
                    tone={can("submit") ? "secondary" : "primary"}
                    disabled={busy}
                    onClick={() => setPanel("confirm")}
                  >
                    {n.priorBillingConfirmedAt ? "Update prior billing" : "Confirm prior billing"}
                  </Button>
                ) : null}
                {can("correct_date") ? (
                  <Button tone="secondary" disabled={busy} onClick={() => setPanel("correct")}>
                    Correct date
                  </Button>
                ) : null}
                {can("void") ? (
                  <Button
                    tone="danger"
                    disabled={busy}
                    onClick={() =>
                      run(
                        "void",
                        (key) =>
                          client.POST("/api/v1/billing/transfer-notices/{id}/void", {
                            params: params(key),
                          }),
                        "The void could not be drafted.",
                      )
                    }
                  >
                    Void (8xD)
                  </Button>
                ) : null}
                {can("redraft") ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      run(
                        "redraft",
                        (key) =>
                          client.POST("/api/v1/billing/transfer-notices/{id}/redraft", {
                            params: params(key),
                          }),
                        "The notice could not be redrafted.",
                      )
                    }
                  >
                    Redraft
                  </Button>
                ) : null}
                {can("cancel") ? (
                  <Button tone="tertiary" disabled={busy} onClick={() => setPanel("cancel")}>
                    Cancel notice
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

function ConfirmForm({
  notice: n,
  busy,
  onCancel,
  onSubmit,
}: {
  notice: TransferNotice;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (d: ConfirmDraft) => void;
}): JSX.Element {
  const [d, setD] = useState<ConfirmDraft>({
    throughDate: n.priorHospiceThroughDate ?? n.statementFromDate,
    patientStatus: n.priorHospicePatientStatus ?? "",
    ccn: "",
    npi: "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof ConfirmDraft, string>>>({});
  const needs = { ccn: n.priorHospiceCcn === null, npi: n.priorHospiceNpi === null };
  const submit = () => {
    const e = validateConfirm(d, needs);
    setErrors(e);
    if (Object.keys(e).length === 0) onSubmit(d);
  };
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <p className="wx-row-sub">
        Confirm only after {n.priorHospiceName} has finalized its billing. Medicare accepts the
        transfer only if their final claim runs through the transfer date,{" "}
        {fmtDay(n.statementFromDate)}.
      </p>
      <TextField
        label="Their final claim's Through date"
        type="date"
        required
        value={d.throughDate}
        error={errors.throughDate}
        onChange={(e) => setD({ ...d, throughDate: e.target.value })}
      />
      <SelectField
        label="Patient status on that claim"
        required
        value={d.patientStatus}
        error={errors.patientStatus}
        options={[{ value: "", label: "Select…" }, ...PATIENT_STATUS_OPTIONS]}
        onChange={(e) =>
          setD({ ...d, patientStatus: e.target.value as ConfirmDraft["patientStatus"] })
        }
      />
      {needs.ccn ? (
        <TextField
          label="Their CCN"
          hint="Not recorded at transfer-in. Required: a transfer from our own CCN is not allowed."
          maxLength={6}
          value={d.ccn}
          error={errors.ccn}
          onChange={(e) => setD({ ...d, ccn: e.target.value.toUpperCase() })}
        />
      ) : null}
      {needs.npi ? (
        <TextField
          label="Their NPI"
          hint="Optional."
          inputMode="numeric"
          maxLength={10}
          value={d.npi}
          error={errors.npi}
          onChange={(e) => setD({ ...d, npi: e.target.value })}
        />
      ) : null}
      <FormFooter busy={busy} label="Confirm" onCancel={onCancel} onSubmit={submit} />
    </div>
  );
}

function CorrectForm({
  onFile,
  busy,
  onCancel,
  onSubmit,
}: {
  onFile: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (date: string) => void;
}): JSX.Element {
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <p className="wx-row-sub">
        Drafts a corrected notice: the correct date is reported as From, and the date on file (
        {fmtDay(onFile)}) with occurrence code 56 and condition code D0.
      </p>
      <TextField
        label="Correct transfer date"
        type="date"
        required
        value={date}
        error={error ?? undefined}
        onChange={(e) => setDate(e.target.value)}
      />
      <FormFooter
        busy={busy}
        label="Draft correction"
        onCancel={onCancel}
        onSubmit={() => {
          const e = validateCorrection(date, onFile);
          setError(e);
          if (!e) onSubmit(date);
        }}
      />
    </div>
  );
}

function CancelForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: "0.75rem" }}>
      <TextAreaField
        label="Why cancel this notice?"
        required
        rows={3}
        maxLength={1000}
        value={reason}
        error={error ?? undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      <FormFooter
        busy={busy}
        label="Cancel notice"
        onCancel={onCancel}
        onSubmit={() => {
          const e = reason.trim() ? null : "Enter a reason.";
          setError(e);
          if (!e) onSubmit(reason.trim());
        }}
      />
    </div>
  );
}
