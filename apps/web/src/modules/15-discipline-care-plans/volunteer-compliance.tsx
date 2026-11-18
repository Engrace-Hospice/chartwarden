import {
  Button,
  CursorPagination,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/15-discipline-care-plans — the VOLUNTEER COMPLIANCE GATES MANAGER (§5.1 #11).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_VOLUNTEER_MANAGEMENT.md — "Use Work Queue."
//
// The coordinator's 42 CFR §418.78(b)/(d) grid: every recorded gate with the status the validity window
// ACTUALLY implies as of now, plus create / correct / revoke.
//
// The screen shows `effectiveStatus`, not the materialized `storedStatus`: the nightly watcher writes the
// stored column, so between runs a gate that expired at midnight still reads `satisfied` in the table it
// was written to. The server re-derives the effective value per read (§2.2.6) and that is what governs
// scheduling — showing the stale column would tell a coordinator a volunteer is clear when M17 will refuse
// them. Where the two disagree the row says so.
//
// This is a WORKFORCE-credential surface, not patient data: no patient identifier appears, which is why
// route 19 carries a documented read-audit waiver rather than a patient-less PHI read event.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { MembershipLookupField } from "../../shell/entity-lookups";
import { FormDrawer } from "../../shell/form-drawer";
import { type GateView, errorMessage, listGates, writeHeaders } from "./discipline-api";
import {
  FAILING_GATE_STATUSES,
  GATE_STATUS_TONE,
  dueLabel,
  gateKindLabel,
  humanize,
  shortDate,
  shortId,
  toneOf,
} from "./discipline-status";
import { FilterRow, Modal, Notice, SelectField, TextAreaField, TextField } from "./discipline-ui";

/** `volunteer_gate_kind` (enums.ts §3.2) — the seven 418.78 postures. */
const GATE_KINDS = [
  "background_check",
  "tb_screening",
  "confidentiality_agreement",
  "initial_training",
  "annual_ce",
  "assignment_specific_training",
  "vaccination_status",
] as const;

const KIND_FILTER_OPTIONS = [
  { value: "", label: "Any gate kind" },
  ...GATE_KINDS.map((k) => ({ value: k, label: gateKindLabel(k) })),
];
const KIND_OPTIONS = GATE_KINDS.map((k) => ({ value: k, label: gateKindLabel(k) }));
const EXPIRY_OPTIONS = [
  { value: "", label: "Any expiry" },
  { value: "7", label: "Expiring within 7 days" },
  { value: "14", label: "Expiring within 14 days" },
  { value: "30", label: "Expiring within 30 days" },
];
const PAGE_SIZE = 25;
/** A write whose fetch rejected: the answer, if any, never arrived. The retry is safe (the client keeps its idempotency key). */
const CONNECTION_DROPPED =
  "The connection dropped before the server answered, so we can't tell whether it went through. Check your connection and try again.";

/** The one form drawer beside the grid: record a new gate or correct a row's. Opening one replaces the other. */
type GateForm = { readonly kind: "new" } | { readonly kind: "edit"; readonly gate: GateView };

export function VolunteerComplianceGates(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<GateView[]>([]);
  const [volunteerFilter, setVolunteerFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [expiryFilter, setExpiryFilter] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<(string | null)[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<GateForm | null>(null);
  const [revoking, setRevoking] = useState<GateView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { page, error: err } = await listGates(client, {
      ...(volunteerFilter.trim() ? { volunteerMembershipId: volunteerFilter.trim() } : {}),
      ...(kindFilter ? { gateKind: kindFilter } : {}),
      ...(expiryFilter ? { expiringWithinDays: Number(expiryFilter) } : {}),
      ...(cursor ? { cursor } : {}),
      limit: PAGE_SIZE,
    });
    if (err) {
      setError(
        errorMessage(err, "The volunteer compliance gates are unavailable in this session."),
      );
      setLoading(false);
      return;
    }
    setRows(page?.data ?? []);
    setNextCursor(page?.next_cursor ?? null);
    setHasMore(Boolean(page?.has_more));
    setLoading(false);
  }, [client, volunteerFilter, kindFilter, expiryFilter, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  function resetPage(): void {
    setCursor(null);
    setPreviousCursors([]);
  }

  function updateVolunteerFilter(value: string): void {
    setVolunteerFilter(value);
    resetPage();
  }

  function updateKindFilter(value: string): void {
    setKindFilter(value);
    resetPage();
  }

  function updateExpiryFilter(value: string): void {
    setExpiryFilter(value);
    resetPage();
  }

  function nextPage(): void {
    if (!nextCursor) return;
    setPreviousCursors((stack) => [...stack, cursor]);
    setCursor(nextCursor);
  }

  function previousPage(): void {
    setPreviousCursors((stack) => {
      const nextStack = [...stack];
      const previous = nextStack.pop() ?? null;
      setCursor(previous);
      return nextStack;
    });
  }

  const failing = rows.filter((g) => FAILING_GATE_STATUSES.includes(g.effectiveStatus));
  const expiring = rows.filter((g) => g.effectiveStatus === "expiring_soon");
  const blockedVolunteers = new Set(failing.map((g) => g.volunteerMembershipId));
  const drifted = rows.filter((g) => g.storedStatus !== g.effectiveStatus);

  // Record / correct a gate opens in the detail rail (a drawer), above the alerts, not over the page.
  const closeForm = () => setForm(null);
  const gateSaved = () => {
    closeForm();
    void load();
  };
  const formDrawer =
    form === null ? null : form.kind === "new" ? (
      <GateFormDrawer
        key="new"
        title="Record compliance gate"
        onClose={closeForm}
        onSaved={gateSaved}
      />
    ) : (
      <GateFormDrawer
        key={form.gate.gateId}
        title={`Correct ${gateKindLabel(form.gate.gateKind)}`}
        gate={form.gate}
        onClose={closeForm}
        onSaved={gateSaved}
      />
    );

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Volunteer compliance"
            actions={
              <div style={{ display: "flex", gap: t.space2 }}>
                <Button
                  type="button"
                  tone="secondary"
                  onClick={() => void load()}
                  loading={loading}
                >
                  Refresh
                </Button>
                <Button type="button" onClick={() => setForm({ kind: "new" })}>
                  Record gate
                </Button>
              </div>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Manage the live workforce gates that determine whether a volunteer can be scheduled.
            </div>
          </PageHeader>
        }
        filters={
          <FilterRow>
            <MembershipLookupField
              label="Volunteer"
              value={volunteerFilter}
              onChange={updateVolunteerFilter}
            />
            <SelectField
              label="Gate kind"
              value={kindFilter}
              options={KIND_FILTER_OPTIONS}
              onChange={updateKindFilter}
            />
            <SelectField
              label="Expiry window"
              value={expiryFilter}
              options={EXPIRY_OPTIONS}
              onChange={updateExpiryFilter}
            />
          </FilterRow>
        }
        table={
          error ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title="Unavailable" description={error} />
            </div>
          ) : loading ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No gates"
                description="No compliance gate matches this filter. A volunteer with no recorded gate is not schedulable."
              />
            </div>
          ) : (
            <div style={tableWrapStyle}>
              <table>
                <thead>
                  <tr>
                    <th>Volunteer</th>
                    <th>Gate</th>
                    <th>Valid from</th>
                    <th>Valid until</th>
                    <th>Evidence</th>
                    <th>Status</th>
                    <th>&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <tr key={g.gateId}>
                      <td className="wx-data-md">{shortId(g.volunteerMembershipId)}</td>
                      <td>{gateKindLabel(g.gateKind)}</td>
                      <td>{shortDate(g.validFrom)}</td>
                      <td>
                        {g.validUntil ? (
                          <>
                            {shortDate(g.validUntil)}
                            <div className="wx-text-muted">{dueLabel(g.validUntil)}</div>
                          </>
                        ) : (
                          <span className="wx-text-muted">no expiry</span>
                        )}
                      </td>
                      <td className="wx-data-md">{shortId(g.sourceDocumentId)}</td>
                      <td>
                        <StatusPill
                          label={humanize(g.effectiveStatus)}
                          tone={toneOf(GATE_STATUS_TONE, g.effectiveStatus)}
                        />
                        {g.storedStatus !== g.effectiveStatus ? (
                          <div className="wx-text-muted">
                            last written as {humanize(g.storedStatus).toLowerCase()}
                          </div>
                        ) : null}
                        {g.revokedAt ? (
                          <div className="wx-text-muted">revoked {shortDate(g.revokedAt)}</div>
                        ) : null}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: t.space2 }}>
                          <Button
                            tone="secondary"
                            type="button"
                            onClick={() => setForm({ kind: "edit", gate: g })}
                          >
                            Correct
                          </Button>
                          {g.revokedAt ? null : (
                            <Button tone="secondary" type="button" onClick={() => setRevoking(g)}>
                              Revoke
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <CursorPagination
                loadedCount={rows.length}
                hasNextPage={hasMore}
                hasPreviousPage={previousCursors.length > 0}
                onNextPage={nextPage}
                onPreviousPage={previousPage}
                loading={loading}
                noun="compliance gates"
              />
            </div>
          )
        }
        detail={
          <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
            {formDrawer}
            <Notice tone={failing.length > 0 ? "error" : "success"}>
              {failing.length === 0
                ? "Every gate on this page is satisfied or approaching expiry — no volunteer is blocked by the currently loaded rows."
                : `${blockedVolunteers.size} volunteer${blockedVolunteers.size === 1 ? "" : "s"} on this page cannot be scheduled: an expired, revoked or not-yet-satisfied gate fails 418.78 and the scheduler refuses the assignment.`}
            </Notice>
            {expiring.length > 0 ? (
              <Notice tone="warning">
                {expiring.length} loaded gate{expiring.length === 1 ? "" : "s"} expire soon.
                Expiring soon warns; it does not block.
              </Notice>
            ) : null}
            {drifted.length > 0 ? (
              <Notice tone="warning">
                {drifted.length} row{drifted.length === 1 ? "" : "s"} show a status the nightly
                watcher has not written yet. The status shown here — re-derived from the validity
                window — is the one the scheduler enforces.
              </Notice>
            ) : null}
            <span className="wx-text-muted">
              Alerts fire at 30 / 14 / 7 / 1 days before expiry. `Expiring soon` warns; it does not
              block.
            </span>
          </div>
        }
        fullPageScroll
      />

      {revoking ? (
        <RevokeGateModal
          gate={revoking}
          onClose={() => setRevoking(null)}
          onSaved={() => {
            setRevoking(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

/** Routes 20 / 21 — record a new gate, or correct a recorded one's window / evidence. */
function GateFormDrawer({
  title,
  gate,
  onClose,
  onSaved,
}: {
  title: string;
  gate?: GateView;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [volunteerMembershipId, setVolunteer] = useState(gate?.volunteerMembershipId ?? "");
  const [gateKind, setGateKind] = useState(gate?.gateKind ?? GATE_KINDS[0]);
  const [validFrom, setValidFrom] = useState(shortDateInput(gate?.validFrom));
  const [validUntil, setValidUntil] = useState(shortDateInput(gate?.validUntil));
  const [sourceDocumentId, setSourceDocument] = useState(gate?.sourceDocumentId ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editingExisting = gate !== undefined;
  const canSubmit = editingExisting || (volunteerMembershipId.trim() !== "" && validFrom !== "");

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let saved = false;
    try {
      const common = {
        validUntil: validUntil === "" ? null : new Date(validUntil).toISOString(),
        sourceDocumentId: sourceDocumentId.trim() === "" ? null : sourceDocumentId.trim(),
        ...(notes.trim() === "" ? {} : { notes }),
      };
      const res = editingExisting
        ? await client.PATCH("/api/v1/volunteer-compliance-gates/{gateId}", {
            params: { path: { gateId: gate.gateId }, header: writeHeaders(gate.version) },
            body: common,
          } as never)
        : await client.POST("/api/v1/volunteer-compliance-gates", {
            params: { header: writeHeaders() },
            body: {
              volunteerMembershipId,
              gateKind,
              validFrom: new Date(validFrom).toISOString(),
              ...common,
            },
          } as never);
      if (res.error) setError(errorMessage(res.error, "The gate could not be saved."));
      else saved = true;
    } catch {
      // The client rejects on a network failure: without this the drawer would stay busy, and undismissable, for good.
      setError(CONNECTION_DROPPED);
    } finally {
      setBusy(false);
    }
    if (saved) onSaved();
  }

  return (
    <FormDrawer
      title={title}
      busy={busy}
      onClose={onClose}
      error={error}
      save={
        <Button
          tone="primary"
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit || busy}
        >
          {busy ? "Saving…" : "Save gate"}
        </Button>
      }
    >
      {editingExisting ? (
        <span className="wx-text-muted">
          A correction changes the validity window and the evidence only. The volunteer and gate
          kind identify the row and cannot be re-pointed — record a new gate instead.
        </span>
      ) : null}
      <MembershipLookupField
        label="Volunteer"
        value={volunteerMembershipId}
        onChange={editingExisting ? () => undefined : setVolunteer}
        disabled={editingExisting}
      />
      <SelectField
        label="Gate kind"
        value={gateKind}
        options={KIND_OPTIONS}
        onChange={editingExisting ? () => undefined : setGateKind}
      />
      <TextField label="Valid from" type="date" value={validFrom} onChange={setValidFrom} />
      <TextField
        label="Valid until (blank = no expiry)"
        type="date"
        value={validUntil}
        onChange={setValidUntil}
      />
      <TextField label="Source document id" value={sourceDocumentId} onChange={setSourceDocument} />
      <TextAreaField label="Notes" value={notes} onChange={setNotes} rows={2} />
    </FormDrawer>
  );
}

/** Route 22 — revoke a satisfied gate. The reason is stored and the volunteer goes inactive at once. */
function RevokeGateModal({
  gate,
  onClose,
  onSaved,
}: { gate: GateView; onClose: () => void; onSaved: () => void }): JSX.Element {
  const client = useApiClient();
  const [revokedReason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    let revoked = false;
    try {
      const res = await client.POST("/api/v1/volunteer-compliance-gates/{gateId}/revoke", {
        params: { path: { gateId: gate.gateId }, header: writeHeaders(gate.version) },
        body: { revokedReason },
      } as never);
      if (res.error) setError(errorMessage(res.error, "The gate could not be revoked."));
      else revoked = true;
    } catch {
      setError(CONNECTION_DROPPED);
    } finally {
      setBusy(false);
    }
    if (revoked) onSaved();
  }

  return (
    <Modal
      title={`Revoke ${gateKindLabel(gate.gateKind)}`}
      onClose={onClose}
      footer={
        <Button
          tone="primary"
          type="button"
          onClick={() => void submit()}
          disabled={revokedReason.trim() === "" || busy}
        >
          {busy ? "Revoking…" : "Revoke gate"}
        </Button>
      }
    >
      <Notice tone="error">
        Revoking fails this volunteer's 418.78 posture immediately: their active assignments are
        inactivated and the scheduler refuses new ones until the gate is satisfied again.
      </Notice>
      <TextAreaField
        label="Reason"
        value={revokedReason}
        onChange={setReason}
        rows={3}
        hint="Stored on the gate and carried into the expiry cascade audit."
      />
      {error ? <p className="wx-text-error">{error}</p> : null}
    </Modal>
  );
}

/** An instant → the `<input type="date">` value it maps to (empty for null). */
function shortDateInput(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "";
}

const tableWrapStyle = {
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
  minWidth: 0,
} as const;
