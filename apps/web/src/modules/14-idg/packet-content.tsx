// apps/web/src/modules/14-idg — the packet's built-snapshot content, shared by the full packet page and the
// live-meeting centre panel. Spec: docs/design/screens/clinical/WARDENX_UI_IDG_MEETING.md "Patient Packet (center)".
//
// Semantics the server guarantees (and this file never papers over):
//  - `content: null` ⇒ the snapshot is missing / unsupported — said so, never blank.
//  - `hopeTimepoints.captured === false` ⇒ "not captured by this build", NOT "none due".
//  - Empty arrays are legitimate → "None recorded". "Not captured" is used ONLY where the API says so.
//  - `appliedSudRedaction` ⇒ the server's `redactionNotice` is shown and NOTHING else hints at withheld content
//    (the activeSudFlag is deliberately never drawn).
import {
  CountBadge,
  DataTable,
  type DataTableColumn,
  Glyph,
  InfoRows,
  Panel,
  StatusPill,
  type StatusTone,
  type operations,
  useApiClient,
} from "@wardenx/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import "./live-meeting.css";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;

/** GET /idg/meetings/{meetingId}/packets/{patientId}. */
export type PacketDetail = Ok<operations["getApiV1IdgMeetingsByMeetingIdPacketsByPatientId"]>;
export type PacketContent = NonNullable<PacketDetail["content"]>;
type Discipline = PacketContent["disciplines"][number];

export type PacketLoad =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; packet: PacketDetail };

/**
 * Fetches one patient's packet. Packets are frozen or built, so the result is cached per
 * (patient, packetId, frozenAt) for the lifetime of the mount — the live 10s poll never refetches them. A stale
 * request (selection changed / unmounted) is aborted. `versionKey === null` ⇒ no packet is built: no request.
 */
export function usePacketDetail(
  meetingId: string | undefined,
  patientId: string | null | undefined,
  versionKey: string | null,
): PacketLoad {
  const client = useApiClient();
  const cache = useRef(new Map<string, PacketDetail>());
  const [state, setState] = useState<{ key: string; load: PacketLoad } | null>(null);
  const key =
    meetingId && patientId && versionKey ? `${meetingId}|${patientId}|${versionKey}` : null;

  useEffect(() => {
    if (!key || !meetingId || !patientId) return;
    if (cache.current.has(key)) return;
    const ctl = new AbortController();
    setState({ key, load: { status: "loading" } });
    void client
      .GET("/api/v1/idg/meetings/{meetingId}/packets/{patientId}", {
        params: { path: { meetingId, patientId } },
        signal: ctl.signal,
      })
      .then((r) => {
        if (ctl.signal.aborted) return;
        if (r.error || !r.data) {
          setState({ key, load: { status: "error" } });
          return;
        }
        const packet = r.data as PacketDetail;
        cache.current.set(key, packet);
        setState({ key, load: { status: "ok", packet } });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setState({ key, load: { status: "error" } });
      });
    return () => ctl.abort();
  }, [client, key, meetingId, patientId]);

  if (!key) return { status: "idle" };
  const hit = cache.current.get(key);
  if (hit) return { status: "ok", packet: hit };
  return state?.key === key ? state.load : { status: "loading" };
}

// ── formatting ─────────────────────────────────────────────────────────────────────────────────────────

const ACRONYMS = new Set(["dme", "hope", "iv", "prn", "rn", "lvn", "msw", "dpoa", "f2f"]);
const humanize = (k: string): string =>
  k
    .replace(/_/g, " ")
    .replace(/\b\w+/g, (w) =>
      ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.replace(/^\w/, (c) => c.toUpperCase()),
    );

/** Date-only strings (yyyy-mm-dd) are read as a local calendar day so no timezone shift moves them. */
function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? v
    : `${fmtDate(v)} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

const DISCIPLINE_LABEL: Record<string, string> = {
  rn: "RN",
  msw: "MSW",
  chaplain: "Chaplain",
  aide: "Aide",
  md_np: "MD/NP",
  medical_director: "Medical Director",
  volunteer: "Volunteer",
};
const disciplineLabel = (d: string): string => DISCIPLINE_LABEL[d] ?? humanize(d);

const SEVERITY: Record<string, { label: string; tone: StatusTone }> = {
  info: { label: "Info", tone: "neutral" },
  attention: { label: "Attention", tone: "warning" },
  urgent: { label: "Urgent", tone: "error" },
};
function SeverityPill({ severity }: { severity: string | null }): JSX.Element | null {
  if (!severity) return null;
  const s = SEVERITY[severity] ?? { label: humanize(severity), tone: "neutral" as StatusTone };
  return <StatusPill label={s.label} tone={s.tone} />;
}

const F2F: Record<string, { label: string; tone: StatusTone }> = {
  not_due: { label: "F2F not due", tone: "neutral" },
  window_open: { label: "F2F window open", tone: "warning" },
  overdue: { label: "F2F overdue", tone: "error" },
};

// ── 42 CFR Part 2 ──────────────────────────────────────────────────────────────────────────────────────

/** The server's redaction notice, and nothing else about what was withheld. */
export function RedactionBanner({ packet }: { packet: PacketDetail }): JSX.Element | null {
  if (!packet.appliedSudRedaction) return null;
  return (
    <p className="wx-idg-alert" data-tone="info" role="note" aria-label="Restricted content notice">
      <Glyph name="lock" size={16} />
      <span>
        {packet.redactionNotice ?? "Part of this packet is restricted under 42 CFR Part 2."}
      </span>
    </p>
  );
}

/** `content: null` — the snapshot is missing or its schema is not supported by this build. */
export function NoContentNotice(): JSX.Element {
  return (
    <div className="wx-idg-alert" data-tone="warning">
      <Glyph name="alert-circle" size={16} />
      <div>
        <strong>Packet snapshot unavailable</strong>
        <p>
          The built snapshot for this packet is missing or uses an unsupported schema version, so
          its cover summary, discipline views and changes cannot be shown.
        </p>
      </div>
    </div>
  );
}

// ── cover ──────────────────────────────────────────────────────────────────────────────────────────────

function FlagChips({ flags }: { flags: PacketContent["cover"]["discussionFlags"] }): JSX.Element {
  if (flags.length === 0) return <p className="wx-row-sub">No discussion flags.</p>;
  return (
    <ul className="wx-packet-flags" aria-label="Discussion flags">
      {flags.map((f, i) => (
        <li key={`${f.kind}-${i}`}>
          <StatusPill label={humanize(f.kind)} tone="warning" />
          {f.detail ? <span>{f.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function CarePlanValue({ cp }: { cp: PacketContent["cover"]["carePlan"] }): JSX.Element {
  return (
    <span className="wx-packet-cp">
      <span>
        {cp.activeProblemCount} problems · {cp.activeGoalCount} goals · {cp.activeInterventionCount}{" "}
        interventions
      </span>
      <span className="wx-row-sub">
        Last signed <span className="wx-nums">{fmtDate(cp.lastSignedAt)}</span> · review due{" "}
        <span className="wx-nums">{fmtDate(cp.nextReviewDueAt)}</span>
      </span>
      {cp.isReviewOverdue ? <StatusPill label="Care plan review overdue" tone="error" /> : null}
    </span>
  );
}

/** Cover summary card: the server's deterministic summary + key facts + discussion flags. */
export function PacketCover({ content }: { content: PacketContent }): JSX.Element {
  const c = content.cover;
  const f2f = c.recert.f2fWindowState ? F2F[c.recert.f2fWindowState] : null;
  return (
    <Panel title="Cover summary" icon="file-check">
      <p className="wx-packet-summary">{c.summary}</p>
      <InfoRows
        labelWidth="8rem"
        rows={[
          { label: "Age", value: <span className="wx-nums">{c.age}</span> },
          {
            label: "Primary diagnosis",
            value: (
              <span>
                {c.primaryDiagnosisLabel}
                <span className="wx-row-sub wx-nums">{c.primaryDiagnosisIcd10}</span>
              </span>
            ),
          },
          { label: "Level of care", value: humanize(c.levelOfCare) },
          { label: "On service", value: <span className="wx-nums">Day {c.daysOnService}</span> },
          {
            label: "Recert due",
            value: (
              <span className="wx-idg-live-pills">
                <span className="wx-nums">{fmtDate(c.recert.nextRecertDueAt)}</span>
                {f2f ? <StatusPill label={f2f.label} tone={f2f.tone} /> : null}
              </span>
            ),
          },
          { label: "Care plan", value: <CarePlanValue cp={c.carePlan} /> },
          {
            label: "Since",
            value: (
              <span>
                {c.sinceContext === "first_idg" ? "First IDG review" : "Since the last IDG review"}
                <span className="wx-row-sub wx-nums">{fmtDateTime(c.sinceCursorAt)}</span>
              </span>
            ),
          },
          ...(c.hasActiveDpoa
            ? [
                {
                  label: "Decision-maker",
                  value: <StatusPill label="Active DPOA" tone="progress" />,
                },
              ]
            : []),
          { label: "Built", value: <span className="wx-nums">{fmtDateTime(c.builtAt)}</span> },
        ]}
      />
      <h3 className="wx-packet-sub">Discussion flags</h3>
      <FlagChips flags={c.discussionFlags} />
    </Panel>
  );
}

// ── disciplines ────────────────────────────────────────────────────────────────────────────────────────

interface ItemRow {
  id: string;
  item: Discipline["items"][number];
}

/** Tab strip (shared `.wx-subtabs` pattern) over the disciplines the server returned, in its order. */
export function DisciplineViews({
  content,
  compact = false,
}: {
  content: PacketContent;
  compact?: boolean;
}): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const discs = content.disciplines;
  const current = discs.find((d) => d.discipline === selected) ?? discs[0] ?? null;
  const columns: DataTableColumn<ItemRow>[] = [
    {
      id: "item",
      header: "Item",
      cell: (r) => (
        <span>
          <span className="wx-row-title">{r.item.label}</span>
          <span className="wx-row-sub">{humanize(r.item.sourceKind)}</span>
        </span>
      ),
    },
    { id: "summary", header: "Summary", cell: (r) => r.item.summary },
    {
      id: "severity",
      header: "Severity",
      cell: (r) => <SeverityPill severity={r.item.severity} />,
    },
  ];
  const body = (
    <>
      {current === null ? (
        <p className="wx-rail-empty">No discipline views are included in this packet.</p>
      ) : (
        <>
          <div className="wx-subtabs wx-subtabs-scroll" role="tablist" aria-label="Disciplines">
            {discs.map((d) => (
              <button
                key={d.discipline}
                type="button"
                role="tab"
                id={`packet-tab-${d.discipline}`}
                aria-selected={d.discipline === current.discipline}
                aria-controls="packet-discipline-view"
                onClick={() => setSelected(d.discipline)}
              >
                {disciplineLabel(d.discipline)}
                <span className="wx-seg-count wx-nums">{d.items.length}</span>
              </button>
            ))}
          </div>
          <div
            className="wx-packet-disc"
            role="tabpanel"
            id="packet-discipline-view"
            aria-labelledby={`packet-tab-${current.discipline}`}
          >
            <p className="wx-packet-oneline">{current.oneLineSummary}</p>
            <DataTable
              ariaLabel={`${disciplineLabel(current.discipline)} items`}
              rows={current.items.map((item, i) => ({
                id: `${item.sourceKind}:${item.sourceId}:${i}`,
                item,
              }))}
              getRowId={(r) => r.id}
              columns={compact ? columns.filter((c) => c.id !== "severity") : columns}
              empty={
                <p className="wx-rail-empty">
                  No {disciplineLabel(current.discipline)} items in this packet.
                </p>
              }
            />
            <div className="wx-packet-questions">
              <h3 className="wx-packet-sub">Open questions</h3>
              {current.openQuestions.length === 0 ? (
                <p className="wx-row-sub">No open questions.</p>
              ) : (
                <ul>
                  {current.openQuestions.map((q, i) => (
                    <li key={`${i}-${q}`}>{q}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
  return compact ? (
    <div className="wx-packet-bare">{body}</div>
  ) : (
    <Panel title="Discipline views" icon="users" flush>
      {body}
    </Panel>
  );
}

// ── change sections ────────────────────────────────────────────────────────────────────────────────────

function ChangePanel<T>({
  title,
  icon,
  rows,
  getRowId,
  columns,
  emptyText = "None recorded.",
}: {
  title: string;
  icon: "clipboard-list" | "file-check" | "scale" | "alert-circle" | "check-circle" | "activity";
  rows: T[];
  getRowId: (r: T, i: number) => string;
  columns: DataTableColumn<T>[];
  emptyText?: string;
}): JSX.Element {
  const keyed = rows.map((r, i) => ({ r, id: getRowId(r, i) }));
  return (
    <Panel
      title={title}
      icon={icon}
      flush
      action={<CountBadge count={rows.length} tone="primary" />}
    >
      <DataTable
        ariaLabel={title}
        rows={keyed}
        getRowId={(k) => k.id}
        columns={columns.map((c) => ({ ...c, cell: (k: { r: T; id: string }) => c.cell(k.r) }))}
        empty={<p className="wx-rail-empty">{emptyText}</p>}
      />
    </Panel>
  );
}

const when = (v: string): ReactNode => <span className="wx-nums">{fmtDateTime(v)}</span>;

/**
 * F-230 — the external (DoseSpot/Surescripts MedHx) medication-history STATE, shown explicitly (M12 §5.5).
 * `captured: false` (not captured by this build) and `not_pulled` (no pull was ever ingested) are NEVER worded
 * as "no external history"; only a pull that ran and returned zero entries is (`none_available`).
 */
function ExternalMedicationHistoryPanel({
  history,
}: {
  history: PacketContent["externalMedicationHistory"];
}): JSX.Element {
  return (
    <Panel
      title="External medication history"
      icon="pill"
      action={
        history.captured && history.state === "available" && history.recordCount !== null ? (
          <CountBadge count={history.recordCount} tone="primary" />
        ) : undefined
      }
    >
      {!history.captured ? (
        <p className="wx-row-sub" data-testid="ext-med-history-not-captured">
          External medication history is not captured by this build.
        </p>
      ) : history.state === "none_available" ? (
        <p className="wx-row-sub" data-testid="ext-med-history-none">
          {history.message}
          {history.lastPulledAt ? <> (last pulled {when(history.lastPulledAt)})</> : null}
        </p>
      ) : history.state === "available" ? (
        <InfoRows
          labelWidth="9rem"
          rows={[
            {
              label: "Entries (latest pull)",
              value:
                history.recordCount === null ? (
                  "Not available"
                ) : (
                  <span className="wx-nums">{history.recordCount}</span>
                ),
            },
            {
              label: "Last pulled",
              value: history.lastPulledAt ? when(history.lastPulledAt) : "—",
            },
          ]}
        />
      ) : (
        <p className="wx-row-sub" data-testid="ext-med-history-not-pulled">
          {history.message ?? "External medication history has not been pulled for this patient."}
        </p>
      )}
    </Panel>
  );
}

/** HOPE timepoints — `captured: false` means "not captured by this build", never "none due". */
function HopePanel({ hope }: { hope: PacketContent["hopeTimepoints"] }): JSX.Element {
  if (!hope.captured) {
    return (
      <Panel title="HOPE timepoints" icon="activity">
        <p className="wx-row-sub" data-testid="hope-not-captured">
          HOPE timepoints are not captured by this build, so upcoming due dates, open symptom
          follow-up visits and symptom-impact triggers are not shown.
        </p>
      </Panel>
    );
  }
  return (
    <Panel
      title="HOPE timepoints"
      icon="activity"
      action={
        <CountBadge
          count={hope.upcoming.length + hope.symptomImpactTriggers.length}
          tone="primary"
        />
      }
    >
      <InfoRows
        labelWidth="9rem"
        rows={[
          {
            label: "Open SFVs",
            value:
              hope.openSfvCount === null ? (
                "Not available"
              ) : (
                <span className="wx-nums">{hope.openSfvCount}</span>
              ),
          },
        ]}
      />
      <h3 className="wx-packet-sub">Upcoming timepoints</h3>
      <DataTable
        ariaLabel="Upcoming HOPE timepoints"
        rows={hope.upcoming.map((u, i) => ({ ...u, id: `${u.timepoint}-${i}` }))}
        getRowId={(u) => u.id}
        columns={[
          { id: "tp", header: "Timepoint", cell: (u) => <b>{humanize(u.timepoint)}</b> },
          { id: "due", header: "Due", cell: (u) => when(u.dueAt) },
        ]}
        empty={<p className="wx-rail-empty">No upcoming timepoints recorded.</p>}
      />
      <h3 className="wx-packet-sub">Symptom-impact triggers</h3>
      <DataTable
        ariaLabel="Symptom-impact triggers"
        rows={hope.symptomImpactTriggers.map((s, i) => ({
          ...s,
          id: `${s.hopeAssessmentId}-${i}`,
        }))}
        getRowId={(s) => s.id}
        columns={[
          { id: "kind", header: "Trigger", cell: (s) => <b>{humanize(s.triggerKind)}</b> },
          { id: "fired", header: "Fired", cell: (s) => when(s.firedAt) },
        ]}
        empty={<p className="wx-rail-empty">No symptom-impact triggers recorded.</p>}
      />
    </Panel>
  );
}

/** Every change section of the snapshot. `who` resolves a membership id to a name (id prefix fallback). */
export function PacketChanges({
  content,
  who,
}: {
  content: PacketContent;
  who: (membershipId: string) => string;
}): JSX.Element {
  return (
    <>
      <ChangePanel
        title="Signed encounters"
        icon="file-check"
        rows={content.signedEncounters}
        getRowId={(r, i) => `${r.encounterId}-${i}`}
        columns={[
          { id: "type", header: "Encounter", cell: (r) => <b>{humanize(r.encounterType)}</b> },
          { id: "disc", header: "Discipline", cell: (r) => disciplineLabel(r.discipline) },
          { id: "signed", header: "Signed", cell: (r) => when(r.signedAt) },
        ]}
      />
      <ChangePanel
        title="Assessment changes"
        icon="clipboard-list"
        rows={content.assessmentChanges}
        getRowId={(r, i) => `${r.assessmentId}-${i}`}
        columns={[
          { id: "scale", header: "Scale", cell: (r) => <b>{humanize(r.scaleKind)}</b> },
          { id: "change", header: "Change", cell: (r) => humanize(r.changeKind) },
          { id: "at", header: "When", cell: (r) => when(r.occurredAt) },
        ]}
      />
      <ExternalMedicationHistoryPanel history={content.externalMedicationHistory} />
      <HopePanel hope={content.hopeTimepoints} />
      <ChangePanel
        title="Order changes"
        icon="scale"
        rows={content.orderChanges}
        getRowId={(r, i) => `${r.orderId}-${i}`}
        columns={[
          { id: "kind", header: "Order", cell: (r) => <b>{humanize(r.orderKind)}</b> },
          { id: "change", header: "Change", cell: (r) => humanize(r.changeKind) },
          { id: "at", header: "When", cell: (r) => when(r.changedAt) },
        ]}
      />
      <ChangePanel
        title="Medication changes"
        icon="clipboard-list"
        rows={content.medicationChanges}
        getRowId={(r, i) => `${r.medicationOrderId}-${i}`}
        columns={[
          { id: "drug", header: "Medication", cell: (r) => <b>{r.drugLabel}</b> },
          { id: "change", header: "Change", cell: (r) => humanize(r.changeKind) },
          { id: "at", header: "When", cell: (r) => when(r.changedAt) },
        ]}
      />
      <ChangePanel
        title="Flagged events"
        icon="alert-circle"
        rows={content.flaggedEvents}
        getRowId={(r, i) => `${r.sourceId}-${i}`}
        columns={[
          { id: "kind", header: "Event", cell: (r) => <b>{humanize(r.kind)}</b> },
          { id: "sev", header: "Severity", cell: (r) => <SeverityPill severity={r.severity} /> },
          { id: "at", header: "When", cell: (r) => when(r.occurredAt) },
        ]}
      />
      <ChangePanel
        title="Carry-forward action items"
        icon="check-circle"
        rows={content.carryForwardActionItems}
        getRowId={(r, i) => `${r.actionItemId}-${i}`}
        columns={[
          {
            id: "who",
            header: "Assignee",
            cell: (r) => <b>{who(r.assignedToMembershipId)}</b>,
          },
          {
            id: "due",
            header: "Due",
            cell: (r) => <span className="wx-nums">{fmtDate(r.dueDate)}</span>,
          },
          {
            id: "cf",
            header: "Carried forward",
            cell: (r) => <span className="wx-nums">{r.carryForwardCount}×</span>,
          },
        ]}
      />
    </>
  );
}

/** Compact view for the live-meeting centre panel: summary, headline facts, flags, discipline tabs. */
export function PacketCompact({ packet }: { packet: PacketDetail }): JSX.Element {
  const content = packet.content;
  return (
    <div className="wx-packet-compact">
      <RedactionBanner packet={packet} />
      {content === null || content === undefined ? (
        <NoContentNotice />
      ) : (
        <>
          <p className="wx-packet-summary">{content.cover.summary}</p>
          <ul className="wx-packet-facts" aria-label="Key facts">
            <li>{content.cover.age} y</li>
            <li>
              {content.cover.primaryDiagnosisLabel}{" "}
              <span className="wx-nums">({content.cover.primaryDiagnosisIcd10})</span>
            </li>
            <li>{humanize(content.cover.levelOfCare)}</li>
            <li className="wx-nums">Day {content.cover.daysOnService}</li>
            {content.cover.carePlan.isReviewOverdue ? (
              <li>
                <StatusPill label="Care plan review overdue" tone="error" />
              </li>
            ) : null}
          </ul>
          {content.cover.discussionFlags.length > 0 ? (
            <FlagChips flags={content.cover.discussionFlags} />
          ) : null}
          <DisciplineViews content={content} compact />
        </>
      )}
    </div>
  );
}
