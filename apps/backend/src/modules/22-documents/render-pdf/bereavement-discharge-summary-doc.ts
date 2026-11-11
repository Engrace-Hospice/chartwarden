// apps/backend/src/modules/22-documents/render-pdf/bereavement-discharge-summary-doc.ts — ADR-0109 D9. The
// `bereavement_discharge_summary_internal` template: M16's `BereavementDischargeSummaryRenderPayload` -> a {@link DocModel}. Pure.
//
// AN INTERNAL AUDITOR'S RECORD, AND THE PAYLOAD IS AN ALLOWLIST. The summary states what the program OFFERED and what it DELIVERED, per
// contact and per cadence mark, the assessment checkpoints done and missed, the contacts it could not reach, each contact's opt-out and
// mailing scope, the tier trajectory and why the program closed. This builder reads exactly those fields BY NAME and nothing else, so a
// producer bug that put a counselor's contact notes, a care goal, a risk-factor vector or substance-use data on the wire still could not
// reach the PDF; the schema (`@chartwarden/types` render-payloads/m16-bereavement) does not declare them either.
import { type Block, type DocModel, latestInstant } from "./doc-model";
import { arr, fmtDate, fmtInstant, humanize, rec, str } from "./shared";

export const BEREAVEMENT_DISCHARGE_SUMMARY_TITLE =
  "Bereavement Program Discharge Summary (Internal)";

/** Cadence marks whose stored name is not the label the program uses (ADR-0109 D2: the 9-month call keeps its legacy name). */
const MARK_LABEL: Readonly<Record<string, string>> = {
  nine_month: "Month 9 call",
  anniversary: "Anniversary card",
  anniversary_call: "Anniversary call",
  closeout_letter: "Closeout letter",
  one_month: "One-month call (retired mark)",
};

const markLabel = (mark: unknown): string => MARK_LABEL[str(mark) ?? ""] ?? humanize(mark);

const CLOSE_KIND_LABEL: Readonly<Record<string, string>> = {
  auto: "Automatic (13-month clock)",
  manual: "Recorded by staff",
  cascade: "Cascade from another record",
};

const MARK_TABLE_COLUMNS = [
  { header: "Cadence item", weight: 3 },
  { header: "Kind", weight: 2 },
  { header: "Due", weight: 2 },
  { header: "Status", weight: 2 },
  { header: "Completed", weight: 2 },
] as const;

const TASK_TABLE_COLUMNS = [
  { header: "Checkpoint", weight: 3 },
  { header: "Due", weight: 2 },
  { header: "Status", weight: 2 },
  { header: "Completed", weight: 2 },
] as const;

const TIER_TABLE_COLUMNS = [
  { header: "As of", weight: 3 },
  { header: "Risk tier", weight: 2 },
] as const;

const count = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? String(v) : "-";

function tierRows(points: unknown): string[][] {
  return arr(points).map((p) => [fmtInstant(rec(p).at), humanize(rec(p).tier)]);
}

function contactBlocks(contact: unknown): Block[] {
  const c = rec(contact);
  const blocks: Block[] = [];
  const name = str(c.label) ?? "Contact";
  blocks.push({ kind: "heading", level: 2, text: `${name} (${humanize(c.relationship)})` });

  const optOuts = arr(c.optOuts).map(rec);
  const facts: Array<readonly [string, string]> = [
    ["Status at close", humanize(c.status)],
    ["Mailings", c.mailingsAllowed === false ? "Stopped (calls continue)" : "Allowed"],
  ];
  if (optOuts.length > 0) {
    facts.push([
      "Open opt-outs",
      optOuts
        .map((o) => {
          const channels = arr(o.channelKinds)
            .map((k) => humanize(k))
            .join(", ");
          return `${humanize(o.optOutKind)}${channels === "" ? "" : ` (${channels})`} since ${fmtDate(o.optedOutAt)}`;
        })
        .join("; "),
    ]);
  }
  const unreachable = c.unreachable;
  if (unreachable !== null && unreachable !== undefined) {
    const u = rec(unreachable);
    facts.push([
      "Could not be reached",
      `${count(u.attemptCount)} attempt(s); last attempt ${fmtInstant(u.lastAttemptAt)}`,
    ]);
  }
  blocks.push({ kind: "facts", rows: facts });

  blocks.push({ kind: "heading", level: 3, text: "Offered and delivered" });
  blocks.push({
    kind: "table",
    columns: MARK_TABLE_COLUMNS,
    rows: arr(c.touchpoints).map((t) => {
      const r = rec(t);
      return [
        markLabel(r.cadenceMark),
        humanize(r.kind),
        fmtDate(r.dueAt),
        humanize(r.status),
        r.completedAt === null || r.completedAt === undefined ? "-" : fmtDate(r.completedAt),
      ];
    }),
    emptyText: "No cadence items were scheduled for this contact.",
  });

  blocks.push({ kind: "heading", level: 3, text: "Assessment checkpoints" });
  blocks.push({
    kind: "table",
    columns: TASK_TABLE_COLUMNS,
    rows: arr(c.assessmentTasks).map((t) => {
      const r = rec(t);
      return [
        humanize(r.taskKind),
        fmtDate(r.dueAt),
        humanize(r.status),
        r.completedAt === null || r.completedAt === undefined ? "-" : fmtDate(r.completedAt),
      ];
    }),
    emptyText: "No assessment checkpoints were scheduled for this contact.",
  });

  blocks.push({ kind: "heading", level: 3, text: "Risk tier over time" });
  blocks.push({
    kind: "table",
    columns: TIER_TABLE_COLUMNS,
    rows: tierRows(c.tierTrajectory),
    emptyText: "No risk score was recorded for this contact.",
  });
  return blocks;
}

/** The internal discharge summary: closure facts, totals, then each contact's offered-versus-delivered record. */
export function buildBereavementDischargeSummaryDoc(payload: unknown): DocModel {
  const p = rec(payload);
  const totals = rec(p.totals);
  const contacts = arr(p.contacts);
  const blocks: Block[] = [];

  blocks.push({
    kind: "title",
    text: BEREAVEMENT_DISCHARGE_SUMMARY_TITLE,
    subtitle: str(p.closedAt) === undefined ? undefined : `Program closed ${fmtDate(p.closedAt)}`,
  });
  blocks.push({
    kind: "banner",
    tone: "info",
    text: "Internal record for auditors. It is not shared with the family or the portal.",
  });

  blocks.push({ kind: "heading", level: 1, text: "Program" });
  blocks.push({
    kind: "facts",
    rows: [
      ["Date of death", fmtDate(p.deathDate)],
      ["Closed", fmtInstant(p.closedAt)],
      ["Closure reason", humanize(p.closureReason)],
      ["Closed by", CLOSE_KIND_LABEL[str(p.closeKind) ?? ""] ?? humanize(p.closeKind)],
      ["Bereaved contacts", String(contacts.length)],
    ],
  });

  blocks.push({ kind: "heading", level: 1, text: "Offered and delivered, all contacts" });
  blocks.push({
    kind: "facts",
    rows: [
      ["Cadence items offered", count(totals.offered)],
      ["Delivered (completed or declined by the family)", count(totals.delivered)],
      ["Missed", count(totals.missed)],
      ["Cancelled (opt-out, pause or closure)", count(totals.cancelled)],
      ["Still outstanding at close", count(totals.outstanding)],
    ],
  });

  blocks.push({ kind: "heading", level: 1, text: "Plan risk tier over time" });
  blocks.push({
    kind: "table",
    columns: TIER_TABLE_COLUMNS,
    rows: tierRows(p.planTierTrajectory),
    emptyText: "No plan-level risk score was recorded.",
  });

  blocks.push({ kind: "heading", level: 1, text: "Contacts" });
  if (contacts.length === 0) {
    blocks.push({
      kind: "paragraph",
      muted: true,
      text: "The plan closed with no bereaved contacts on its roster.",
    });
  }
  for (const contact of contacts) blocks.push(...contactBlocks(contact));

  blocks.push({
    kind: "paragraph",
    muted: true,
    text: "Contact notes, care goals, risk-factor detail and substance-use information are not part of this record.",
  });

  return {
    title: BEREAVEMENT_DISCHARGE_SUMMARY_TITLE,
    createdAtIso: latestInstant([p.closedAt]),
    blocks,
  };
}
