// apps/backend/src/modules/22-documents/render-pdf/idg-minutes-doc.ts — the `idg_minutes` template: the M14
// `renderPayload` (frozen attendance / decision / action-item / per-discipline-note snapshots, plus the
// live `disciplineAddenda` appendix on an addendum or amendment re-render) -> a {@link DocModel}. Pure.
//
// 42 CFR Part 2: M14 already elides `bodyText`/`reason` for withheld patients (`bodyWithheld: true`, both
// null) at snapshot time. This builder ENFORCES it a second time: a withheld entry contributes metadata and
// the fixed "Withheld — 42 CFR Part 2" line ONLY — it never reads `bodyText` / `reason` / the patient
// identity off such an entry, so a producer bug that leaves text on the wire still cannot reach the PDF.
import { type Block, type DocModel, latestInstant } from "./doc-model";
import {
  PART2_WITHHELD,
  type Rec,
  arr,
  bool,
  disciplineLabel,
  fmtDate,
  fmtInstant,
  humanize,
  isRec,
  rec,
  shortId,
  str,
} from "./shared";

export const IDG_MINUTES_TITLE = "IDG Meeting Minutes";

/** Resolve a membership to a display name from the payload's optional `memberNames` map. */
function nameOf(names: Rec, membershipId: unknown, fallbackDiscipline?: unknown): string {
  const id = str(membershipId);
  const n = id === undefined ? undefined : str(names[id]);
  if (n !== undefined) return n;
  return fallbackDiscipline !== undefined
    ? `${disciplineLabel(fallbackDiscipline)} (name unavailable)`
    : "Name unavailable";
}

function patientLabel(labels: Rec, patientId: unknown): string {
  const id = str(patientId);
  if (id === undefined) return "Meeting-level";
  return str(labels[id]) ?? `Patient ${shortId(id)}`;
}

export function buildIdgMinutesDoc(payload: unknown): DocModel {
  const p = rec(payload);
  const meeting = rec(p.meeting);
  const names = rec(p.memberNames);
  const patients = rec(p.patientLabels);
  const attendance = arr(p.attendanceSnapshot).filter(isRec);
  const decisions = arr(p.decisionListSnapshot).filter(isRec);
  // Live decision CONTENT (re-derived at emit; the frozen snapshot holds the kind only), keyed by decision id.
  const contentById = new Map<string, Rec>();
  for (const c of arr(p.decisionContent).filter(isRec)) {
    const cid = str(c.decisionId);
    if (cid !== undefined) contentById.set(cid, c);
  }
  const actions = arr(p.actionItemListSnapshot).filter(isRec);
  const notes = arr(p.disciplineNoteSnapshot).filter(isRec);
  const addenda = arr(p.disciplineAddenda).filter(isRec);
  const amendmentCount = typeof p.amendmentCount === "number" ? p.amendmentCount : 0;
  const amended = p.minutesStatus === "amended" || bool(p.amended) || amendmentCount > 0;

  const blocks: Block[] = [];
  blocks.push({
    kind: "title",
    text: "Interdisciplinary Group (IDG) Meeting Minutes",
    subtitle:
      [str(meeting.organizationName), str(meeting.locationName)].filter(Boolean).join(" - ") ||
      undefined,
  });

  blocks.push({
    kind: "facts",
    rows: [
      ["Meeting date", fmtDate(meeting.actualStart ?? meeting.scheduledStart)],
      ["Scheduled start", fmtInstant(meeting.scheduledStart)],
      ["Actual start", fmtInstant(meeting.actualStart)],
      ["Adjourned", fmtInstant(meeting.actualEnd)],
      ["Status", amended ? "Amended" : "Final"],
      ...(amended && amendmentCount > 0 ? ([["Amendments", String(amendmentCount)]] as const) : []),
      ["Meeting reference", shortId(str(meeting.meetingId))],
    ],
  });

  if (amended) {
    blocks.push({
      kind: "banner",
      tone: "warn",
      text: "AMENDED - these minutes were amended after they were finalized. This version supersedes the earlier finalized minutes; earlier versions are retained in the document history.",
    });
  }
  if (addenda.length > 0) {
    blocks.push({
      kind: "banner",
      tone: "info",
      text: `This document includes ${addenda.length} late addend${addenda.length === 1 ? "um" : "a"} recorded after adjournment (see Appendix: Addenda). The finalized minutes above are unchanged.`,
    });
  }

  // ── Attendance ──
  blocks.push({ kind: "heading", level: 1, text: "Attendance" });
  blocks.push({
    kind: "table",
    columns: [
      { header: "Name", weight: 3 },
      { header: "Discipline", weight: 3 },
      { header: "Status", weight: 1.5 },
      { header: "Checked in", weight: 2.2 },
    ],
    rows: attendance.map((a) => [
      nameOf(names, a.membershipId, a.discipline),
      disciplineLabel(a.discipline),
      humanize(a.status),
      fmtInstant(a.checkInAt),
    ]),
    emptyText: "No attendance was recorded for this meeting.",
  });

  // ── Decisions ──
  blocks.push({ kind: "heading", level: 1, text: "Decisions" });
  const decisionRefs = new Map<string, number>();
  decisions.forEach((d, i) => {
    const id = str(d.decisionId);
    if (id !== undefined) decisionRefs.set(id, i + 1);
  });
  blocks.push({
    kind: "table",
    columns: [
      { header: "#", weight: 0.6 },
      { header: "Decision", weight: 2.4 },
      { header: "Patient", weight: 2.4 },
      { header: "Status", weight: 1.4 },
      { header: "Quorum", weight: 1.1 },
      { header: "Recorded", weight: 2.2 },
    ],
    rows: decisions.map((d, i) => {
      const content = contentById.get(str(d.decisionId) ?? "");
      const sup = str(d.supersededByDecisionId) ?? str(content?.supersededByDecisionId);
      const supNo = sup === undefined ? undefined : decisionRefs.get(sup);
      const status = content?.status === "superseded" ? "superseded" : d.status;
      return [
        String(i + 1),
        humanize(d.decisionKind),
        // Part 2: a withheld decision never labels its patient.
        content !== undefined && bool(content.withheld)
          ? PART2_WITHHELD
          : patientLabel(patients, d.patientId),
        sup === undefined
          ? humanize(status)
          : `${humanize(status)} (superseded by ${supNo === undefined ? shortId(sup) : `#${supNo}`})`,
        d.wasQuorate === false ? "Non-quorate" : "Quorate",
        fmtInstant(d.recordedAt),
      ];
    }),
    emptyText: "No decisions were recorded at this meeting.",
  });

  // ── Decision details (live content; Part 2 metadata-only) ──
  const detailed = decisions.filter((d) => contentById.has(str(d.decisionId) ?? ""));
  if (detailed.length > 0) {
    blocks.push({ kind: "heading", level: 2, text: "Decision details" });
    decisions.forEach((d, i) => {
      const content = contentById.get(str(d.decisionId) ?? "");
      if (content === undefined) return;
      blocks.push(decisionEntry(i + 1, d, content, patients, decisionRefs));
    });
  }

  // ── Action items ──
  blocks.push({ kind: "heading", level: 1, text: "Action items" });
  blocks.push({
    kind: "table",
    columns: [
      { header: "Assigned to", weight: 3 },
      { header: "Patient", weight: 2.4 },
      { header: "Status", weight: 1.4 },
      { header: "Due", weight: 1.4 },
      { header: "Decision", weight: 0.9 },
    ],
    rows: actions.map((a) => {
      const decNo =
        str(a.decisionId) === undefined ? undefined : decisionRefs.get(str(a.decisionId) as string);
      return [
        str(a.assignedToMembershipId) !== undefined &&
        str(names[str(a.assignedToMembershipId) as string])
          ? str(a.assignedToDiscipline) === undefined
            ? nameOf(names, a.assignedToMembershipId)
            : `${nameOf(names, a.assignedToMembershipId)} (${disciplineLabel(a.assignedToDiscipline)})`
          : disciplineLabel(a.assignedToDiscipline),
        patientLabel(patients, a.patientId),
        humanize(a.status),
        fmtDate(a.dueDate),
        decNo === undefined ? "-" : `#${decNo}`,
      ];
    }),
    emptyText: "No action items were assigned at this meeting.",
  });

  // ── Per-discipline notes (frozen at adjournment) ──
  blocks.push({ kind: "heading", level: 1, text: "Discipline notes" });
  if (notes.length === 0) {
    blocks.push({
      kind: "paragraph",
      muted: true,
      text: "No discipline notes were recorded at this meeting.",
    });
  } else {
    const byDiscipline = new Map<string, Rec[]>();
    for (const n of notes) {
      const key = str(n.discipline) ?? "unspecified";
      byDiscipline.set(key, [...(byDiscipline.get(key) ?? []), n]);
    }
    for (const [discipline, group] of [...byDiscipline.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      blocks.push({ kind: "heading", level: 2, text: disciplineLabel(discipline) });
      for (const n of group) blocks.push(noteEntry(n, names, patients, "note"));
    }
  }

  // ── Appendix: Addenda ──
  if (addenda.length > 0) {
    blocks.push({ kind: "pageBreak" });
    blocks.push({ kind: "heading", level: 1, text: "Appendix: Addenda" });
    blocks.push({
      kind: "paragraph",
      muted: true,
      text: "Addenda are appended after adjournment and never alter the finalized minutes. Listed in the order recorded.",
    });
    for (const a of addenda) blocks.push(noteEntry(a, names, patients, "addendum"));
  }

  const createdAtIso = latestInstant([
    meeting.actualEnd,
    meeting.scheduledStart,
    ...attendance.map((a) => a.checkInAt),
    ...decisions.map((d) => d.recordedAt),
    ...notes.flatMap((n) => [n.createdAt, n.updatedAt]),
    ...addenda.map((a) => a.recordedAt),
  ]);
  return { title: IDG_MINUTES_TITLE, createdAtIso, blocks };
}

/** One decision's content. A withheld decision NEVER touches summary text or the patient identity. */
function decisionEntry(
  no: number,
  d: Rec,
  content: Rec,
  patients: Rec,
  refs: ReadonlyMap<string, number>,
): Block {
  const kind = humanize(content.decisionKind ?? d.decisionKind);
  const sup = str(content.supersededByDecisionId) ?? str(d.supersededByDecisionId);
  const supNo = sup === undefined ? undefined : refs.get(sup);
  const status =
    sup === undefined
      ? humanize(content.status ?? d.status)
      : `${humanize(content.status ?? d.status)} (superseded by ${supNo === undefined ? shortId(sup) : `#${supNo}`})`;
  const meta = `#${no} ${kind} - ${status} - ${fmtInstant(content.recordedAt ?? d.recordedAt)}`;
  if (bool(content.withheld)) {
    return { kind: "entry", withheld: true, meta, body: PART2_WITHHELD };
  }
  const lines = arr(content.summary).filter((l): l is string => typeof l === "string");
  return {
    kind: "entry",
    meta,
    muted:
      str(content.patientId) === undefined
        ? "Meeting-level"
        : patientLabel(patients, content.patientId),
    body: lines.length > 0 ? lines.join("\n") : "(no decision text recorded)",
  };
}

/** One note or addendum. A withheld entry NEVER touches text, reason or patient identity. */
function noteEntry(n: Rec, names: Rec, patients: Rec, kind: "note" | "addendum"): Block {
  const withheld = bool(n.bodyWithheld);
  const author =
    str(names[str(n.authorMembershipId) ?? ""]) ??
    str(n.authorName) ??
    nameOf(names, n.authorMembershipId);
  const when = fmtInstant(kind === "addendum" ? (n.recordedAt ?? n.createdAt) : n.createdAt);
  const version = typeof n.version === "number" && n.version > 1 ? ` (edited, v${n.version})` : "";
  if (withheld) {
    return {
      kind: "entry",
      withheld: true,
      meta: `${disciplineLabel(n.discipline)} - ${author} - ${when}`,
      body: PART2_WITHHELD,
    };
  }
  const subject = patientLabel(patients, n.patientId);
  const reason = str(n.reason);
  return {
    kind: "entry",
    meta: `${disciplineLabel(n.discipline)} - ${author} - ${when}${version}`,
    muted: `${subject}${reason !== undefined ? ` | Reason: ${reason}` : ""}`,
    body: str(n.bodyText) ?? "(no text)",
  };
}
