// apps/web/src/modules/14-idg — per-discipline meeting notes on the Live Meeting surface.
//
// Each discipline in the room keeps its own running notes, per patient (the worklist selection) or
// meeting-level. THE SERVER OWNS EVERY RULE (ADR-0030): writes only while the meeting is `live`; the patient
// must be on the agenda/packets; a non-coordinator may write only a discipline they are recorded present
// for and edit only their own notes. This panel never pre-decides those — it defaults the discipline to the
// caller's own roster row, shows the composer as read-only once the meeting is not live (that one is a
// display of state the page already holds), and renders the server's 403/422/412 next to the composer.
//
// LIVE POLL SAFETY: the parent re-reads the notes list on every 10s poll and hands it down as a prop. Every
// draft (composer text per scope+discipline, and the open inline edit) lives in THIS component's state, so a
// poll only ever replaces the rendered notes — it never resets what someone is typing.
//
// AFTER ADJOURNMENT: the original notes are the frozen record (no edit control on anything). Within the
// addendum window the composer becomes an "Add late addendum" composer (reason required); an addendum is a
// separate append-only row shown with a "Late addendum" pill, its recorded-at time and its reason.
//
// REASON: every note may carry an optional context `reason` (live notes: blank is omitted; addenda: required).
// The author may edit text and reason while live (only changed fields are sent; clearing sends null).
// WINDOW B: an addendum for a patient is refused once a newer IDG has adjourned for them (`addendumState`
// from the minutes view); the 422/503 codes are still handled inline when that state is stale.
//
// PART 2 (42 CFR): a note the server withheld (`bodyWithheld`) renders a pill, never text or reason.
import { Button, CountBadge, EmptyState, Panel, StatusPill, useApiClient } from "@chartwarden/ui";
import { useMemo, useState } from "react";
import type { JSX } from "react";
import {
  type AddendumState,
  type AttendanceView,
  type DisciplineNoteView,
  createDisciplineNote,
  updateDisciplineNote,
} from "./idg-api";
import {
  ADDENDUM_REASON_MAX,
  addendumWindowEnd,
  canonicalDiscipline,
  disciplineTabs,
} from "./idg-disciplines";

export const NOTE_MAX = 4000;
const SUPERSEDED_MESSAGE =
  "A newer IDG has adjourned for this patient; its record now supersedes this meeting — add your note there.";
export { ADDENDUM_REASON_MAX };

/** `unavailable` = the read failed and there is nothing to show — one quiet line, not a broken pane. */
export type NotesState =
  | { readonly state: "loading" }
  | { readonly state: "ok"; readonly notes: DisciplineNoteView[] }
  | { readonly state: "unavailable" };

const PRESENT = new Set(["present", "tardy", "partial"]);

function stamp(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

const dayStamp = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

interface EditState {
  readonly id: string;
  /** The row version this edit started from — what `If-Match` carries. */
  readonly baseVersion: number;
  readonly text: string;
  readonly reason: string;
  /** What the row held when the edit opened — only fields that differ are sent. */
  readonly baseText: string;
  readonly baseReason: string;
  readonly busy: boolean;
  readonly error: string | null;
  /** After a 412: the text the other writer saved, so it can be compared before saving again. */
  readonly latest: string | null;
}

/** Only the fields the author changed; `reason: null` clears it. Null when nothing changed. */
function editPatch(e: EditState): { bodyText?: string; reason?: string | null } | null {
  const text = e.text.trim();
  const reason = e.reason.trim();
  const patch: { bodyText?: string; reason?: string | null } = {};
  if (text !== e.baseText.trim()) patch.bodyText = text;
  if (reason !== e.baseReason.trim()) patch.reason = reason.length > 0 ? reason : null;
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface DisciplineNotesPanelProps {
  meetingId: string;
  /** True only while the meeting is `live` — the only status the server accepts note writes in. */
  live: boolean;
  /** True when the meeting is `adjourned` — notes written now are late addenda. */
  adjourned?: boolean;
  /** The meeting's actual end (the view's `adjournedAt`); the addendum window is measured from it. */
  adjournedAt?: string | null;
  /** The minutes view's addendum eligibility (adjourned meetings); null/undefined = unknown → the server decides. */
  addendumState?: AddendumState | null;
  /** Human status for the not-live explanation ("Adjourned", "Scheduled", …). */
  statusLabel: string;
  notes: NotesState;
  /** Re-read the notes list; resolves with the fresh rows (null when the read failed). */
  onReload: () => Promise<DisciplineNoteView[] | null>;
  /** The worklist selection (null when no patient is on the agenda yet) and its display label. */
  patientId: string | null;
  patientName: string | null;
  roster: readonly AttendanceView[];
  callerMembershipId: string | null;
  /** Mirrors the resolved idg.attend OR idg.coordinate gate for authoring controls only. */
  canWrite: boolean;
  /** Holds idg.coordinate: may edit others' notes (the server still decides). */
  canEditAny: boolean;
  who: (membershipId: string) => string;
}

export function DisciplineNotesPanel(props: DisciplineNotesPanelProps): JSX.Element {
  const { meetingId, live, statusLabel, notes, onReload, patientId, patientName, roster } = props;
  const adjourned = props.adjourned === true;
  const addendumState = adjourned ? (props.addendumState ?? null) : null;
  const stateEnd = addendumState?.closesAt ? new Date(addendumState.closesAt) : null;
  const windowEnd =
    stateEnd && !Number.isNaN(stateEnd.getTime())
      ? stateEnd
      : adjourned
        ? addendumWindowEnd(props.adjournedAt)
        : null;
  // Unknown adjournment time → leave the composer open; the server owns the window (422 ADDENDUM_WINDOW_CLOSED).
  const windowOpen =
    adjourned &&
    (addendumState ? addendumState.open : windowEnd === null || windowEnd.getTime() >= Date.now());
  const mode: "note" | "addendum" | "closed" | "off" = live
    ? "note"
    : adjourned
      ? windowOpen
        ? "addendum"
        : "closed"
      : "off";
  const composerOpen = props.canWrite && (mode === "note" || mode === "addendum");
  const supersededIds = addendumState?.supersededPatientIds ?? [];
  const client = useApiClient();
  const [scopeChoice, setScopeChoice] = useState<"patient" | "meeting">("patient");
  const [tabChoice, setTabChoice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [composerBusy, setComposerBusy] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);

  const scope: "patient" | "meeting" =
    scopeChoice === "patient" && patientId ? "patient" : "meeting";
  const scopePatientId = scope === "patient" ? patientId : null;
  const allNotes = notes.state === "ok" ? notes.notes : [];
  const inScope = useMemo(
    () => allNotes.filter((n) => (n.patientId ?? null) === scopePatientId),
    [allNotes, scopePatientId],
  );

  const tabs = useMemo(
    () =>
      disciplineTabs(
        roster.map((r) => r.discipline),
        allNotes.map((n) => n.discipline),
      ),
    [roster, allNotes],
  );
  // The caller's own discipline (their present roster row) is the default; otherwise the first tab.
  const ownKey = useMemo(() => {
    const mine = props.callerMembershipId
      ? roster.find((r) => r.membershipId === props.callerMembershipId && PRESENT.has(r.status))
      : undefined;
    return mine ? canonicalDiscipline(mine.discipline) : null;
  }, [roster, props.callerMembershipId]);
  const activeKey =
    (tabChoice && tabs.some((t) => t.key === tabChoice) ? tabChoice : null) ??
    (ownKey && tabs.some((t) => t.key === ownKey) ? ownKey : null) ??
    tabs[0]?.key ??
    null;
  const tab = tabs.find((t) => t.key === activeKey) ?? null;

  const countFor = (key: string): number =>
    inScope.filter((n) => canonicalDiscipline(n.discipline) === key).length;
  // The frozen originals first, then the late addenda (each group keeps the server's oldest-first order).
  const inTab = tab ? inScope.filter((n) => canonicalDiscipline(n.discipline) === tab.key) : [];
  const visible = [...inTab.filter((n) => !n.isAddendum), ...inTab.filter((n) => n.isAddendum)];
  const meetingLevelCount = allNotes.filter((n) => n.patientId === null).length;
  const patientCount = patientId ? allNotes.filter((n) => n.patientId === patientId).length : 0;

  // Patient-scoped only: the meeting-level scope is never superseded.
  const superseded =
    mode === "addendum" && scopePatientId !== null && supersededIds.includes(scopePatientId);
  const draftKey = `${scopePatientId ?? "meeting"}|${tab?.key ?? ""}`;
  const draft = drafts[draftKey] ?? "";
  const reason = reasons[draftKey] ?? "";
  const canSave =
    composerOpen &&
    !composerBusy &&
    tab !== null &&
    !superseded &&
    draft.trim().length > 0 &&
    (mode !== "addendum" || reason.trim().length > 0);

  async function saveNew(): Promise<void> {
    if (!tab || !canSave) return;
    setComposerBusy(true);
    setComposerError(null);
    setSaved(null);
    const res = await createDisciplineNote(client, meetingId, {
      patientId: scopePatientId,
      discipline: tab.value,
      bodyText: draft.trim(),
      // Addendum: required (non-blank, trimmed). Live note: optional context — omitted when blank.
      ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    });
    setComposerBusy(false);
    if (!res.ok) {
      setComposerError(res.message);
      return;
    }
    setDrafts((d) => ({ ...d, [draftKey]: "" }));
    setReasons((r) => ({ ...r, [draftKey]: "" }));
    setSaved(
      mode === "addendum" ? `${tab.label} late addendum saved.` : `${tab.label} note saved.`,
    );
    await onReload();
  }

  async function saveEdit(): Promise<void> {
    if (!edit || edit.busy || edit.text.trim().length === 0) return;
    const patch = editPatch(edit);
    if (!patch) return;
    setEdit({ ...edit, busy: true, error: null });
    const res = await updateDisciplineNote(client, edit.id, edit.baseVersion, patch);
    if (res.ok) {
      setEdit(null);
      setSaved("Note updated.");
      await onReload();
      return;
    }
    if (res.status === 412) {
      // Someone else saved first: pick up their version, keep this draft, let the writer decide.
      const fresh = await onReload();
      const row = fresh?.find((n) => n.id === edit.id);
      setEdit({
        ...edit,
        busy: false,
        baseVersion: row?.version ?? edit.baseVersion,
        latest: row ? (row.bodyText ?? "") : null,
        error: `${res.message} The latest version is loaded${row ? " below" : ""} — review it, then save again to replace it, or cancel.`,
      });
      return;
    }
    setEdit({ ...edit, busy: false, error: res.message });
  }

  const heading = scope === "patient" && patientName ? patientName : "Meeting-level";
  const canEdit = (n: DisciplineNoteView): boolean =>
    props.canWrite &&
    live &&
    !n.bodyWithheld &&
    (props.canEditAny ||
      (props.callerMembershipId !== null && n.authorMembershipId === props.callerMembershipId));

  return (
    <Panel
      title="Discipline notes"
      icon="message-square"
      description="Each discipline's running notes for the selected patient, or for the meeting as a whole."
      action={<CountBadge count={inScope.length} tone="primary" />}
    >
      {notes.state === "loading" ? (
        <p className="wx-row-sub">Loading discipline notes…</p>
      ) : notes.state === "unavailable" ? (
        <p className="wx-row-sub">Discipline notes are unavailable right now.</p>
      ) : (
        <div className="wx-idg-notes">
          <fieldset className="wx-seg" aria-label="Note scope">
            <button
              type="button"
              className={scope === "patient" ? "is-selected" : undefined}
              aria-pressed={scope === "patient"}
              disabled={!patientId}
              onClick={() => {
                setComposerError(null);
                setScopeChoice("patient");
              }}
            >
              {patientName ?? "Selected patient"}
              <span className="wx-seg-count wx-nums">{patientCount}</span>
            </button>
            <button
              type="button"
              className={scope === "meeting" ? "is-selected" : undefined}
              aria-pressed={scope === "meeting"}
              onClick={() => {
                setComposerError(null);
                setScopeChoice("meeting");
              }}
            >
              Meeting-level
              <span className="wx-seg-count wx-nums">{meetingLevelCount}</span>
            </button>
          </fieldset>

          <div
            className="wx-subtabs wx-subtabs-scroll"
            role="tablist"
            aria-label="Note disciplines"
          >
            {tabs.map((d) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                id={`idg-note-tab-${d.key}`}
                aria-selected={d.key === activeKey}
                aria-controls="idg-note-tabpanel"
                onClick={() => {
                  setComposerError(null);
                  setTabChoice(d.key);
                }}
              >
                {d.label}
                <span className="wx-seg-count wx-nums">{countFor(d.key)}</span>
              </button>
            ))}
          </div>

          <div
            id="idg-note-tabpanel"
            role="tabpanel"
            aria-labelledby={activeKey ? `idg-note-tab-${activeKey}` : undefined}
            className="wx-idg-notes-body"
          >
            {saved ? (
              <output className="wx-idg-alert" data-tone="info">
                <span>{saved}</span>
              </output>
            ) : null}
            {visible.length === 0 ? (
              <div className="wx-idg-notes-empty">
                <EmptyState
                  title={`No ${tab?.label ?? "discipline"} notes yet`}
                  description={
                    live
                      ? `Nothing recorded for ${heading} by this discipline. Add the first note below.`
                      : mode === "addendum"
                        ? `Nothing was recorded for ${heading} by this discipline. A late addendum can be added below.`
                        : `Nothing was recorded for ${heading} by this discipline.`
                  }
                />
              </div>
            ) : (
              <ul className="wx-idg-notes-list" aria-label={`${tab?.label ?? ""} notes`}>
                {visible.map((n) => {
                  const editing = edit?.id === n.id ? edit : null;
                  return (
                    <li
                      key={n.id}
                      className="wx-idg-note"
                      data-note-id={n.id}
                      data-addendum={n.isAddendum ? "true" : undefined}
                    >
                      <div className="wx-idg-note-head">
                        <strong className="wx-row-title">
                          {n.authorName ?? props.who(n.authorMembershipId)}
                        </strong>
                        <span className="wx-row-sub wx-nums">
                          {stamp(
                            n.isAddendum ? (n.addendumRecordedAt ?? n.createdAt) : n.createdAt,
                          )}
                        </span>
                        {n.isAddendum ? <StatusPill label="Late addendum" tone="progress" /> : null}
                        {n.version > 1 ? <StatusPill label="Edited" tone="neutral" /> : null}
                        {n.bodyWithheld ? (
                          <StatusPill label="Withheld — Part 2" tone="warning" />
                        ) : null}
                        {!editing && canEdit(n) ? (
                          <Button
                            tone="tertiary"
                            size="sm"
                            onClick={() => {
                              setSaved(null);
                              setEdit({
                                id: n.id,
                                baseVersion: n.version,
                                text: n.bodyText ?? "",
                                reason: n.reason ?? "",
                                baseText: n.bodyText ?? "",
                                baseReason: n.reason ?? "",
                                busy: false,
                                error: null,
                                latest: null,
                              });
                            }}
                          >
                            Edit
                          </Button>
                        ) : null}
                      </div>
                      {n.bodyWithheld ? (
                        <p className="wx-row-sub">
                          The text of this note is not shown — it concerns a 42 CFR Part 2 patient
                          and your account has no release on file.
                        </p>
                      ) : editing ? (
                        <div className="wx-idg-note-edit">
                          <textarea
                            aria-label="Edit note text"
                            rows={4}
                            maxLength={NOTE_MAX}
                            value={editing.text}
                            disabled={editing.busy}
                            onChange={(e) => setEdit({ ...editing, text: e.target.value })}
                          />
                          <label className="wx-idg-note-label" htmlFor={`idg-edit-reason-${n.id}`}>
                            Context / reason (optional)
                          </label>
                          <input
                            id={`idg-edit-reason-${n.id}`}
                            type="text"
                            aria-label="Edit note reason"
                            maxLength={ADDENDUM_REASON_MAX}
                            value={editing.reason}
                            disabled={editing.busy}
                            onChange={(e) => setEdit({ ...editing, reason: e.target.value })}
                          />
                          {editing.error ? (
                            <p className="wx-idg-alert" data-tone="warning" role="alert">
                              <span>{editing.error}</span>
                            </p>
                          ) : null}
                          {editing.latest !== null ? (
                            <blockquote className="wx-idg-note-latest">
                              <span className="wx-row-sub">Latest saved text</span>
                              {editing.latest}
                            </blockquote>
                          ) : null}
                          <div className="wx-idg-note-actions">
                            <span className="wx-row-sub wx-nums">
                              {editing.text.length} / {NOTE_MAX}
                            </span>
                            <Button
                              tone="tertiary"
                              size="sm"
                              disabled={editing.busy}
                              onClick={() => setEdit(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              disabled={
                                editing.busy ||
                                editing.text.trim().length === 0 ||
                                editPatch(editing) === null
                              }
                              onClick={() => void saveEdit()}
                            >
                              {editing.busy ? "Saving…" : "Save changes"}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="wx-idg-note-text">{n.bodyText}</p>
                          {n.reason ? (
                            <p className="wx-row-sub wx-idg-note-reason">Reason: {n.reason}</p>
                          ) : null}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {props.canWrite ? (
              <div className="wx-idg-note-composer" data-mode={mode}>
                <label className="wx-idg-note-label" htmlFor="idg-note-composer">
                  {mode === "addendum" ? "Add late addendum" : "Add a note"} for {heading} ·{" "}
                  {tab?.label ?? ""}
                </label>
                {mode === "addendum" ? (
                  <p className="wx-idg-alert" data-tone="info">
                    <span>
                      Recorded after adjournment. The frozen minutes are not changed; your addendum
                      is appended with a timestamp and reason.
                      {windowEnd ? ` Addenda open until ${dayStamp(windowEnd)}.` : ""}
                    </span>
                  </p>
                ) : null}
                {mode === "closed" ? (
                  <p className="wx-idg-alert" data-tone="warning">
                    <span>
                      Addendum window closed{windowEnd ? ` ${dayStamp(windowEnd)}` : ""}. The notes
                      on this adjourned meeting stay readable and can no longer be added to.
                    </span>
                  </p>
                ) : null}
                {superseded ? (
                  <output className="wx-idg-alert" data-tone="warning">
                    <span>{SUPERSEDED_MESSAGE}</span>
                  </output>
                ) : null}
                {mode === "off" ? (
                  <p className="wx-idg-alert" data-tone="warning">
                    <span>
                      This meeting is {statusLabel.toLowerCase()}, not live — notes can be added or
                      edited only while it is live. Existing notes stay readable.
                    </span>
                  </p>
                ) : null}
                {mode === "addendum" ? (
                  <>
                    <label className="wx-idg-note-label" htmlFor="idg-addendum-reason">
                      Reason for the late addendum
                    </label>
                    <textarea
                      id="idg-addendum-reason"
                      rows={2}
                      maxLength={ADDENDUM_REASON_MAX}
                      placeholder="Why is this being recorded after the meeting?"
                      value={reason}
                      disabled={composerBusy || tab === null || superseded}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSaved(null);
                        setReasons((r) => ({ ...r, [draftKey]: v }));
                      }}
                    />
                    <div className="wx-idg-note-actions">
                      <span
                        className="wx-row-sub wx-nums"
                        data-over={reason.length >= ADDENDUM_REASON_MAX}
                      >
                        {reason.length} / {ADDENDUM_REASON_MAX}
                      </span>
                    </div>
                  </>
                ) : null}
                {mode === "note" ? (
                  <>
                    <label className="wx-idg-note-label" htmlFor="idg-note-reason">
                      Context / reason (optional)
                    </label>
                    <input
                      id="idg-note-reason"
                      type="text"
                      maxLength={ADDENDUM_REASON_MAX}
                      placeholder="Why this note, or what it relates to"
                      value={reason}
                      disabled={composerBusy || tab === null}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSaved(null);
                        setReasons((r) => ({ ...r, [draftKey]: v }));
                      }}
                    />
                    <div className="wx-idg-note-actions">
                      <span
                        className="wx-row-sub wx-nums"
                        data-over={reason.length >= ADDENDUM_REASON_MAX}
                      >
                        {reason.length} / {ADDENDUM_REASON_MAX}
                      </span>
                    </div>
                  </>
                ) : null}
                <textarea
                  id="idg-note-composer"
                  rows={3}
                  maxLength={NOTE_MAX}
                  placeholder={
                    mode === "note"
                      ? "Type this discipline's notes…"
                      : mode === "addendum"
                        ? "Type the addendum…"
                        : "Notes are closed."
                  }
                  value={draft}
                  disabled={!composerOpen || composerBusy || tab === null || superseded}
                  onChange={(e) => {
                    const v = e.target.value;
                    setSaved(null);
                    setDrafts((d) => ({ ...d, [draftKey]: v }));
                  }}
                />
                {composerError ? (
                  <p className="wx-idg-alert" data-tone="warning" role="alert">
                    <span>{composerError}</span>
                  </p>
                ) : null}
                <div className="wx-idg-note-actions">
                  <span className="wx-row-sub wx-nums" data-over={draft.length >= NOTE_MAX}>
                    {draft.length} / {NOTE_MAX}
                  </span>
                  <Button disabled={!canSave} onClick={() => void saveNew()}>
                    {composerBusy ? "Saving…" : mode === "addendum" ? "Save addendum" : "Save note"}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  );
}
