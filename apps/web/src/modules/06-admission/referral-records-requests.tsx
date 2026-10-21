// apps/web/src/modules/06-admission/referral-records-requests.tsx — F-238: ask a prospect's PCP / hospital
// for older records, and follow the requests. Each request has a short code (RR-…) printed on its cover
// sheet; when the records come back by fax (or e-mail with the code in the subject) the intake pipeline
// files them under this referral by that code.
//
// Mounted by the referral page's "Records" tab (`{/* records-requests mount */}`); talks to M22's routes
// over HTTP only (no backend import, no cross-module web import).
import { Button, EmptyState, LoadingSpinner, StatusPill, useApiClient } from "@chartwarden/ui";
import type { CSSProperties, FormEvent, JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { RecordsRequestFaxAction } from "./records-request-fax-action";
import {
  RECORDS_REQUEST_KIND_LABEL,
  RECORDS_REQUEST_STATUS_LABEL,
  type RecordsRequest,
  type RecordsRequestKind,
  type RecordsRequestStatus,
  cancelRecordsRequest,
  coverSheetUrl,
  createRecordsRequest,
  extendRecordsRequest,
  listRecordsRequests,
} from "./records-requests-api";

type Tone = "success" | "progress" | "warning" | "error" | "critical" | "neutral";
const STATUS_TONE: Record<RecordsRequestStatus, Tone> = {
  requested: "progress",
  received: "success",
  partially_received: "warning",
  cancelled: "neutral",
  expired: "warning",
};
const KINDS = Object.keys(RECORDS_REQUEST_KIND_LABEL) as RecordsRequestKind[];
const CANCELLABLE: ReadonlySet<RecordsRequestStatus> = new Set([
  "requested",
  "partially_received",
  "expired",
]);
/** Open (or expired) requests whose expiry staff may push out; an expired one re-opens. */
const EXTENDABLE: ReadonlySet<RecordsRequestStatus> = new Set(["requested", "expired"]);

/** mm/dd/yyyy from an ISO date / timestamp. */
const usDate = (iso: string | null): string => {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
};
/** Today + n days as yyyy-mm-dd (local calendar). */
const inDays = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface FormState {
  recipientName: string;
  recipientOrganization: string;
  recipientFax: string;
  recipientEmail: string;
  kinds: RecordsRequestKind[];
  note: string;
  dateRangeStart: string;
  dateRangeEnd: string;
  dueDate: string;
}
const emptyForm = (): FormState => ({
  recipientName: "",
  recipientOrganization: "",
  recipientFax: "",
  recipientEmail: "",
  kinds: ["history_and_physical", "discharge_summary", "progress_notes", "medication_list"],
  note: "",
  dateRangeStart: "",
  dateRangeEnd: "",
  dueDate: inDays(7),
});

export function ReferralRecordsRequests({ referralId }: { referralId: string }): JSX.Element {
  const client = useApiClient();
  const [items, setItems] = useState<RecordsRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  /** The request whose expiry is being extended, and the new expiry day. */
  const [extending, setExtending] = useState<{ id: string; expiresOn: string } | null>(null);

  const load = useCallback(async () => {
    const res = await listRecordsRequests(client, referralId);
    if (res.ok) {
      setItems(res.value);
      setError(null);
    } else {
      setItems([]);
      setError(res.message);
    }
  }, [client, referralId]);

  useEffect(() => {
    void load();
  }, [load]);

  const printCoverSheet = (requestId: string) => {
    window.open(coverSheetUrl(referralId, requestId), "_blank", "noopener");
  };

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!form.recipientFax.trim() && !form.recipientEmail.trim()) {
      setError("Enter the fax number or the email address the request goes to.");
      return;
    }
    if (form.kinds.length === 0 && !form.note.trim()) {
      setError("Say what is requested: tick at least one record type or describe it.");
      return;
    }
    setBusy("create");
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const res = await createRecordsRequest(client, referralId, {
      recipientName: form.recipientName.trim(),
      recipientOrganization: opt(form.recipientOrganization),
      recipientFax: opt(form.recipientFax),
      recipientEmail: opt(form.recipientEmail),
      recordsRequested: form.kinds,
      recordsRequestedNote: opt(form.note),
      dateRangeStart: opt(form.dateRangeStart),
      dateRangeEnd: opt(form.dateRangeEnd),
      dueDate: opt(form.dueDate),
    });
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setFormOpen(false);
    setForm(emptyForm());
    setItems((prev) => [res.value, ...(prev ?? [])]);
  }

  async function cancel(requestId: string) {
    setBusy(`cancel:${requestId}`);
    const res = await cancelRecordsRequest(client, referralId, requestId);
    setBusy(null);
    setConfirmCancel(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setItems((prev) => (prev ?? []).map((r) => (r.id === requestId ? res.value : r)));
  }

  async function extend(requestId: string, expiresOn: string) {
    setBusy(`extend:${requestId}`);
    const res = await extendRecordsRequest(client, referralId, requestId, { expiresOn });
    setBusy(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setError(null);
    setExtending(null);
    setItems((prev) => (prev ?? []).map((r) => (r.id === requestId ? res.value : r)));
  }

  const toggleKind = (k: RecordsRequestKind) =>
    setForm((f) => ({
      ...f,
      kinds: f.kinds.includes(k) ? f.kinds.filter((x) => x !== k) : [...f.kinds, k],
    }));

  return (
    <section style={section} aria-labelledby="records-requests-heading">
      <div style={head}>
        <h2 id="records-requests-heading" style={heading}>
          Records requests
        </h2>
        {formOpen ? null : (
          <Button size="sm" tone="primary" onClick={() => setFormOpen(true)}>
            Request records
          </Button>
        )}
      </div>
      <p style={muted}>
        Each request has a code printed on its cover sheet. Records faxed back with the cover sheet,
        or emailed with the code in the subject, are filed under this referral automatically. An
        unanswered request expires 30 days after it is due; records that arrive later are still
        filed.
      </p>

      {error ? (
        <p role="alert" style={alert}>
          {error}
        </p>
      ) : null}

      {formOpen ? (
        <form style={formGrid} onSubmit={(ev) => void submit(ev)} aria-label="Request records">
          <div style={row2}>
            <label style={label}>
              Recipient name
              <input
                required
                maxLength={200}
                value={form.recipientName}
                onChange={(ev) => setForm({ ...form, recipientName: ev.target.value })}
                placeholder="Dr. Jane Pell / Medical records"
              />
            </label>
            <label style={label}>
              Organization
              <input
                maxLength={200}
                value={form.recipientOrganization}
                onChange={(ev) => setForm({ ...form, recipientOrganization: ev.target.value })}
              />
            </label>
          </div>
          <div style={row2}>
            <label style={label}>
              Fax number
              <input
                type="tel"
                inputMode="tel"
                maxLength={40}
                value={form.recipientFax}
                onChange={(ev) => setForm({ ...form, recipientFax: ev.target.value })}
              />
            </label>
            <label style={label}>
              Email
              <input
                type="email"
                maxLength={254}
                value={form.recipientEmail}
                onChange={(ev) => setForm({ ...form, recipientEmail: ev.target.value })}
              />
            </label>
          </div>
          <fieldset style={fieldset}>
            <legend style={legend}>Records requested</legend>
            <div style={checks}>
              {KINDS.map((k) => (
                <label key={k} style={checkLabel}>
                  <input
                    type="checkbox"
                    checked={form.kinds.includes(k)}
                    onChange={() => toggleKind(k)}
                  />
                  {RECORDS_REQUEST_KIND_LABEL[k]}
                </label>
              ))}
            </div>
            <label style={label}>
              Other / details
              <textarea
                rows={2}
                maxLength={1000}
                value={form.note}
                onChange={(ev) => setForm({ ...form, note: ev.target.value })}
              />
            </label>
          </fieldset>
          <div style={row3}>
            <label style={label}>
              Dates of service from
              <input
                type="date"
                value={form.dateRangeStart}
                onChange={(ev) => setForm({ ...form, dateRangeStart: ev.target.value })}
              />
            </label>
            <label style={label}>
              to
              <input
                type="date"
                value={form.dateRangeEnd}
                onChange={(ev) => setForm({ ...form, dateRangeEnd: ev.target.value })}
              />
            </label>
            <label style={label}>
              Respond by
              <input
                type="date"
                value={form.dueDate}
                onChange={(ev) => setForm({ ...form, dueDate: ev.target.value })}
              />
            </label>
          </div>
          <div style={actionsRow}>
            <Button type="submit" size="sm" tone="primary" loading={busy === "create"}>
              Create request
            </Button>
            <Button
              type="button"
              size="sm"
              tone="tertiary"
              onClick={() => {
                setFormOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {items === null ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <EmptyState
          title="No records requested yet"
          description="Request older PCP or hospital records when the referral needs more evidence."
        />
      ) : (
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Code</th>
              <th style={th}>Status</th>
              <th style={th}>Recipient</th>
              <th style={th}>Requested</th>
              <th style={th}>Due</th>
              <th style={th}>Expires</th>
              <th style={th}>Files</th>
              <th style={th}>
                <span style={srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td style={td}>
                  <code style={code}>{r.requestCode}</code>
                </td>
                <td style={td}>
                  <StatusPill
                    label={RECORDS_REQUEST_STATUS_LABEL[r.status]}
                    tone={STATUS_TONE[r.status]}
                  />
                  {r.overdue && r.status !== "expired" ? (
                    <span style={overdue}> Overdue</span>
                  ) : null}
                  {r.receivedAfterExpiry ? (
                    <div style={lateNote}>Arrived after expiry — filed anyway</div>
                  ) : null}
                </td>
                <td style={td}>
                  <div>{r.recipientName}</div>
                  <div style={muted}>
                    {[
                      r.recipientOrganization,
                      r.recipientFax ? `Fax ${r.recipientFax}` : null,
                      r.recipientEmail,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                  <div style={muted}>
                    {[
                      ...r.recordsRequested.map((k) => RECORDS_REQUEST_KIND_LABEL[k]),
                      r.recordsRequestedNote,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </div>
                </td>
                <td style={td}>{usDate(r.requestedAt)}</td>
                <td style={td}>{usDate(r.dueDate)}</td>
                <td style={td}>
                  {r.status === "expired" && r.expiredAt ? (
                    <span style={overdue}>Expired {usDate(r.expiredAt)}</span>
                  ) : (
                    usDate(r.expiresOn)
                  )}
                </td>
                <td style={td}>{r.batches}</td>
                <td style={{ ...td, ...actionsCell }}>
                  {r.status !== "cancelled" ? (
                    <Button size="sm" tone="secondary" onClick={() => printCoverSheet(r.id)}>
                      Print cover sheet
                    </Button>
                  ) : null}
                  <RecordsRequestFaxAction referralId={referralId} request={r} />
                  {EXTENDABLE.has(r.status) ? (
                    extending?.id === r.id ? (
                      <>
                        <label style={inlineLabel}>
                          New expiry
                          <input
                            type="date"
                            min={inDays(1)}
                            value={extending.expiresOn}
                            onChange={(ev) =>
                              setExtending({ id: r.id, expiresOn: ev.target.value })
                            }
                          />
                        </label>
                        <Button
                          size="sm"
                          tone="primary"
                          loading={busy === `extend:${r.id}`}
                          disabled={!extending.expiresOn}
                          onClick={() => void extend(r.id, extending.expiresOn)}
                        >
                          {r.status === "expired" ? "Re-open" : "Save expiry"}
                        </Button>
                        <Button size="sm" tone="tertiary" onClick={() => setExtending(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        tone="tertiary"
                        onClick={() => setExtending({ id: r.id, expiresOn: inDays(30) })}
                      >
                        {r.status === "expired" ? "Re-open request" : "Extend"}
                      </Button>
                    )
                  ) : null}
                  {CANCELLABLE.has(r.status) ? (
                    confirmCancel === r.id ? (
                      <>
                        <Button
                          size="sm"
                          tone="danger"
                          loading={busy === `cancel:${r.id}`}
                          onClick={() => void cancel(r.id)}
                        >
                          Confirm cancel
                        </Button>
                        <Button size="sm" tone="tertiary" onClick={() => setConfirmCancel(null)}>
                          Keep
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" tone="tertiary" onClick={() => setConfirmCancel(r.id)}>
                        Cancel request
                      </Button>
                    )
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const section: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
  background: "var(--color-surface)",
  padding: "1rem",
  display: "grid",
  gap: "0.85rem",
  minWidth: 0,
};
const head: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
  flexWrap: "wrap",
};
const heading: CSSProperties = { margin: 0, fontSize: "1rem" };
const muted: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
  margin: 0,
};
const alert: CSSProperties = { color: "var(--color-error)", margin: 0, fontSize: "0.875rem" };
const formGrid: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  padding: "0.85rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "8px",
};
const row2: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
};
const row3: CSSProperties = {
  display: "grid",
  gap: "0.75rem",
  gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
};
const label: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.85rem",
  fontWeight: 600,
};
const fieldset: CSSProperties = {
  border: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gap: "0.5rem",
};
const legend: CSSProperties = {
  fontSize: "0.85rem",
  fontWeight: 600,
  padding: 0,
  marginBottom: "0.35rem",
};
const checks: CSSProperties = { display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem" };
const checkLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.85rem",
};
const actionsRow: CSSProperties = { display: "flex", gap: "0.5rem", flexWrap: "wrap" };
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" };
const th: CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid var(--color-outline-variant)",
  fontWeight: 600,
  fontSize: "0.8125rem",
};
const td: CSSProperties = {
  padding: "0.5rem",
  borderBottom: "1px solid var(--color-outline-variant)",
  verticalAlign: "top",
};
const actionsCell: CSSProperties = {
  display: "flex",
  gap: "0.4rem",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};
const code: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontWeight: 600,
  letterSpacing: "0.04em",
};
const overdue: CSSProperties = {
  color: "var(--color-error)",
  fontSize: "0.8125rem",
  fontWeight: 600,
};
const lateNote: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.8125rem",
  marginTop: "0.25rem",
};
const inlineLabel: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  fontSize: "0.8125rem",
};
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
