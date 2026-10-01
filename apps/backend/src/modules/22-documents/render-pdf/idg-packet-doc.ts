// apps/backend/src/modules/22-documents/render-pdf/idg-packet-doc.ts — the `idg_patient_packet` template: the
// M14 `renderPayload = { snapshot: PacketSnapshot, disciplineViews }` -> a {@link DocModel}. Pure.
//
// Part 2: the snapshot is built (and SUD-redacted when applicable) upstream. This document prints the
// redaction / redisclosure notice whenever the packet was built with `appliedSudRedaction` or the patient
// carries an active SUD flag, and never invents content the snapshot does not carry.
import { type Block, type DocModel, latestInstant } from "./doc-model";
import {
  arr,
  disciplineLabel,
  fmtDate,
  fmtInstant,
  humanize,
  isRec,
  rec,
  shortId,
  str,
} from "./shared";

export const IDG_PACKET_TITLE = "IDG Patient Packet";

const DISCIPLINE_ORDER = [
  "rn",
  "md_np",
  "medical_director",
  "msw",
  "chaplain",
  "aide",
  "volunteer",
];

const num = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "-");
const yesNo = (v: unknown): string => (v === true ? "Yes" : v === false ? "No" : "-");

export function buildIdgPacketDoc(payload: unknown): DocModel {
  const p = rec(payload);
  const snap = rec(p.snapshot);
  const meta = rec(snap.meta);
  const cover = rec(snap.patientCover);
  const since = rec(snap.sinceLastIdg);
  const plan = rec(snap.carePlanSummary);
  const hope =
    snap.hopeContext === null || snap.hopeContext === undefined ? null : rec(snap.hopeContext);
  const views = rec(p.disciplineViews);
  const site = rec(p.meeting);
  const siteLine = [str(site.organizationName), str(site.locationName)].filter(Boolean).join(" - ");
  const memberNames = rec(p.memberNames);
  const nameFor = (id: unknown): string => {
    const s = str(id);
    return s === undefined ? "-" : (str(memberNames[s]) ?? `Member ${shortId(s)}`);
  };
  const part2 = meta.appliedSudRedaction === true || cover.activeSudFlag === true;

  const blocks: Block[] = [];
  blocks.push({
    kind: "title",
    text: "IDG Patient Packet",
    subtitle:
      [siteLine, str(cover.fullNameRedacted)].filter((x) => x && x.length > 0).join(" | ") ||
      undefined,
  });

  if (part2) {
    blocks.push({
      kind: "banner",
      tone: "danger",
      text:
        meta.appliedSudRedaction === true
          ? "42 CFR Part 2: substance use disorder (SUD) treatment content has been redacted from this packet. Redisclosure of any Part 2 record is prohibited without the patient's written consent."
          : "42 CFR Part 2: this patient has an active SUD flag. Records derived from SUD treatment are protected; redisclosure is prohibited without the patient's written consent.",
    });
  }

  // ── Cover summary ──
  blocks.push({ kind: "heading", level: 1, text: "Cover summary" });
  blocks.push({
    kind: "facts",
    rows: [
      ["Patient", str(cover.fullNameRedacted) ?? "-"],
      ["Age", num(cover.age)],
      [
        "Primary diagnosis",
        [str(cover.primaryDiagnosisIcd10), str(cover.primaryDiagnosisLabel)]
          .filter(Boolean)
          .join(" - ") || "-",
      ],
      ["Days on service", num(cover.daysOnService)],
      ["Level of care", humanize(cover.levelOfCare)],
      ["Next recert due", fmtDate(cover.nextRecertDueAt)],
      ["F2F window", cover.f2fWindowState == null ? "-" : humanize(cover.f2fWindowState)],
      [
        "Active DPOA",
        isRec(cover.activeDpoa) ? (str(cover.activeDpoa.agentName) ?? "On file") : "None on file",
      ],
      ["Packet built", fmtInstant(meta.builtAt)],
      [
        "Since",
        `${fmtInstant(meta.sinceCursorIso)} (${meta.sinceContext === "first_idg" ? "first IDG - since admission" : "since prior IDG"})`,
      ],
    ],
  });

  const flags = arr(snap.flagsForDiscussion).filter(isRec);
  blocks.push({ kind: "heading", level: 2, text: "Flags for discussion" });
  if (flags.length === 0) {
    blocks.push({ kind: "paragraph", muted: true, text: "No discussion flags." });
  } else {
    blocks.push({
      kind: "bullets",
      items: flags.map((f) => `${humanize(f.kind)}${str(f.detail) ? `: ${f.detail}` : ""}`),
    });
  }

  blocks.push({ kind: "heading", level: 2, text: "Care plan" });
  blocks.push({
    kind: "facts",
    rows: [
      ["Active problems", num(plan.activeProblemCount)],
      ["Active goals", num(plan.activeGoalCount)],
      ["Active interventions", num(plan.activeInterventionCount)],
      ["Last signed", fmtInstant(plan.lastSignedAt)],
      ["Next review due", fmtInstant(plan.nextReviewDueAt)],
      ["Review overdue", yesNo(plan.isReviewOverdue)],
    ],
  });

  // ── Discipline sections ──
  blocks.push({ kind: "heading", level: 1, text: "Discipline views" });
  const keys = [
    ...DISCIPLINE_ORDER.filter((k) => k in views),
    ...Object.keys(views)
      .filter((k) => !DISCIPLINE_ORDER.includes(k))
      .sort(),
  ];
  if (keys.length === 0) {
    blocks.push({
      kind: "paragraph",
      muted: true,
      text: "No discipline views were built for this packet.",
    });
  }
  for (const key of keys) {
    const v = rec(views[key]);
    blocks.push({ kind: "heading", level: 2, text: disciplineLabel(key) });
    blocks.push({ kind: "paragraph", text: str(v.oneLineSummary) ?? "No summary." });
    const layer2 = isRec(v.layer2Polished) ? str(v.layer2Polished.enhancedSummary) : undefined;
    if (layer2) blocks.push({ kind: "paragraph", text: `Enhanced summary: ${layer2}` });
    const entries = arr(v.highlightedEntries).filter(isRec);
    if (entries.length > 0) {
      blocks.push({
        kind: "table",
        columns: [
          { header: "Source", weight: 1.3 },
          { header: "Item", weight: 2.4 },
          { header: "Detail", weight: 4 },
          { header: "Severity", weight: 1.2 },
        ],
        rows: entries.map((e) => [
          humanize(e.sourceKind),
          str(e.label) ?? "-",
          str(e.summary) ?? "-",
          e.severity === undefined ? "-" : humanize(e.severity),
        ]),
        emptyText: "",
      });
    }
    const questions = arr(v.openQuestions).filter((q): q is string => typeof q === "string");
    if (questions.length > 0) {
      blocks.push({ kind: "paragraph", text: "Open questions:" });
      blocks.push({ kind: "bullets", items: questions });
    }
  }

  // ── Changes since last IDG ──
  blocks.push({ kind: "heading", level: 1, text: "Changes since last IDG" });
  const table = (
    title: string,
    columns: ReadonlyArray<{ header: string; weight: number }>,
    rows: string[][],
    empty: string,
  ): void => {
    blocks.push({ kind: "heading", level: 3, text: title });
    blocks.push({ kind: "table", columns, rows, emptyText: empty });
  };
  table(
    "Signed encounters",
    [
      { header: "Signed", weight: 2.2 },
      { header: "Type", weight: 2 },
      { header: "Author discipline", weight: 2 },
    ],
    arr(since.encounters)
      .filter(isRec)
      .map((e) => [
        fmtInstant(e.signedAt),
        humanize(e.encounterType),
        disciplineLabel(e.authorDiscipline),
      ]),
    "No signed encounters since the last IDG.",
  );
  table(
    "Significant assessment changes",
    [
      { header: "Occurred", weight: 2.2 },
      { header: "Scale", weight: 2 },
      { header: "Change", weight: 2 },
    ],
    arr(since.significantAssessmentChanges)
      .filter(isRec)
      .map((a) => [fmtInstant(a.occurredAt), humanize(a.scaleKind), humanize(a.changeKind)]),
    "No significant assessment changes.",
  );
  table(
    "Order changes",
    [
      { header: "Changed", weight: 2.2 },
      { header: "Order", weight: 2 },
      { header: "Change", weight: 2 },
    ],
    arr(since.ordersChanged)
      .filter(isRec)
      .map((o) => [fmtInstant(o.changedAt), humanize(o.orderKind), humanize(o.changeKind)]),
    "No order changes.",
  );
  table(
    "Medication changes",
    [
      { header: "Changed", weight: 2.2 },
      { header: "Medication", weight: 3 },
      { header: "Change", weight: 2 },
    ],
    arr(since.medicationsChanged)
      .filter(isRec)
      .map((m) => [fmtInstant(m.changedAt), str(m.drugLabel) ?? "-", humanize(m.changeKind)]),
    "No medication changes.",
  );
  table(
    "Flagged events",
    [
      { header: "Occurred", weight: 2.2 },
      { header: "Event", weight: 2.5 },
      { header: "Severity", weight: 1.5 },
    ],
    arr(since.flaggedEvents)
      .filter(isRec)
      .map((f) => [fmtInstant(f.occurredAt), humanize(f.kind), humanize(f.severity)]),
    "No flagged events.",
  );

  // ── HOPE ──
  blocks.push({ kind: "heading", level: 1, text: "HOPE assessment context" });
  const triggers = arr(since.j2051Triggers).filter(isRec);
  if (hope === null) {
    blocks.push({
      kind: "paragraph",
      muted: true,
      text: "HOPE context was not captured for this packet.",
    });
  } else {
    blocks.push({ kind: "facts", rows: [["Open SFV count", num(hope.openSfvCount)]] });
    blocks.push({
      kind: "table",
      columns: [
        { header: "Upcoming timepoint", weight: 3 },
        { header: "Due", weight: 2.5 },
      ],
      rows: arr(hope.upcomingTimepoints)
        .filter(isRec)
        .map((t) => [humanize(t.timepoint), fmtInstant(t.dueAt)]),
      emptyText: "No HOPE timepoints are currently open.",
    });
  }
  table(
    "J2051 symptom-impact triggers",
    [
      { header: "Fired", weight: 2.2 },
      { header: "Trigger", weight: 3 },
    ],
    triggers.map((t) => [fmtInstant(t.firedAt), humanize(t.triggerKind)]),
    "No J2051 triggers since the last IDG.",
  );

  // ── Carry-forward ──
  blocks.push({ kind: "heading", level: 1, text: "Carry-forward action items" });
  blocks.push({
    kind: "table",
    columns: [
      { header: "Assigned to", weight: 3 },
      { header: "Due", weight: 1.6 },
      { header: "Times carried forward", weight: 1.6 },
      { header: "Ref", weight: 1 },
    ],
    rows: arr(snap.carryForwardActionItems)
      .filter(isRec)
      .map((a) => [
        nameFor(a.assignedToMembershipId),
        fmtDate(a.dueDate),
        num(a.carryForwardCount),
        shortId(a.actionItemId),
      ]),
    emptyText: "No action items are being carried forward.",
  });

  if (part2) {
    blocks.push({ kind: "heading", level: 1, text: "42 CFR Part 2 notice" });
    blocks.push({
      kind: "paragraph",
      text: "This packet is subject to the confidentiality rules for substance use disorder patient records (42 CFR Part 2). Content that would identify or describe SUD treatment has been withheld or redacted unless a valid patient consent covers this disclosure. Further disclosure of information from these records is prohibited unless expressly permitted by the patient's written consent or as otherwise permitted by 42 CFR Part 2.",
    });
  }

  const createdAtIso = latestInstant([
    meta.builtAt,
    ...arr(since.encounters)
      .filter(isRec)
      .map((e) => e.signedAt),
  ]);
  return { title: IDG_PACKET_TITLE, createdAtIso, blocks };
}
