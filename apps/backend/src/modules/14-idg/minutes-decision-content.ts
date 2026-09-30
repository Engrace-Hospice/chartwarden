// apps/backend/src/modules/14-idg/minutes-decision-content.ts — the human-readable DECISION CONTENT the M22
// `idg_minutes` PDF prints under each decision row. Pure (no DB): the caller hands it the live `idg_decision`
// rows of the meeting and the set of patients whose text may NOT be shown without a 42 CFR Part 2 release.
//
// WHY A SEPARATE BLOCK. The frozen `decision_list_snapshot` (the immutable §3.3 minutes record, walked by the
// eraser) holds `decisionKind` only and MUST NOT change. The decision payloads are immutable once `emitted`
// (`updateDecision` refuses a non-`open` row), so the content is re-derived at every emit from the live rows and
// rides ONLY the outbox `renderPayload` (`decisionContent`) — never stored, never audited.
//
// PHI. The summary carries free-text clinical narrative (rationale / note / narrative fields — denylisted for
// audit, fine inside an M22 document). It is a SAFE projection: only the known fields of each of the nine typed
// kinds are read (a stray key never reaches the PDF), ids/uuids are never printed, every free-text field is
// capped, and the result is an array of plain lines.
//
// 42 CFR PART 2 (fail-closed, exactly the discipline-note snapshot's rule). A decision whose patient needs a
// release (`releaseNeeded` — active SUD flag OR no packet to vouch for them) contributes METADATA ONLY: kind,
// status, recorded-at, supersede link, `withheld: true`, NO summary and NO patient id (so the builder cannot
// label the patient). Meeting-level decisions (no patient) are never withheld.
import type { Rec } from "./minutes-payload-util";
import { asArr, asRec, asStr } from "./minutes-payload-util";

/** Per free-text field cap (characters) in the render payload; longer text is cut with {@link ELLIPSIS}. */
export const DECISION_TEXT_CAP = 1000;
/** The marker appended to a truncated field. */
export const ELLIPSIS = "… [truncated]";
/** At most this many items (mutations / orders / recommendations) are listed per decision. */
export const DECISION_ITEM_CAP = 20;

export interface DecisionRenderEntry {
  readonly decisionId: string;
  readonly decisionKind: string;
  readonly status: string;
  readonly recordedAt: string;
  readonly supersededByDecisionId: string | null;
  /** NULL when `withheld` — the PDF must not label a Part 2 patient. */
  readonly patientId: string | null;
  readonly withheld: boolean;
  /** Plain-text lines; empty when `withheld`. */
  readonly summary: readonly string[];
}

/** The live row fields this module needs (a structural subset of `idg_decision`). */
export interface DecisionRowInput {
  readonly id: string;
  readonly patientId: string | null;
  readonly decisionKind: string;
  readonly status: string;
  readonly recordedAt: Date | string;
  readonly supersededByDecisionId: string | null;
  readonly payload: unknown;
}

/** Collapse whitespace/control characters and cap to {@link DECISION_TEXT_CAP}. */
export function capText(value: unknown, cap: number = DECISION_TEXT_CAP): string | undefined {
  const s = asStr(value);
  if (s === undefined) return undefined;
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.length > cap ? `${flat.slice(0, cap).trimEnd()}${ELLIPSIS}` : flat;
}

const words = (v: unknown): string | undefined => {
  const s = asStr(v);
  return s === undefined
    ? undefined
    : s
        .split(/[_\-\s]+/)
        .filter(Boolean)
        .map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
};

const join = (parts: ReadonlyArray<string | undefined>, sep = " | "): string =>
  parts.filter((p): p is string => p !== undefined && p.length > 0).join(sep);

const labelled = (label: string, v: string | undefined): string | undefined =>
  v === undefined ? undefined : `${label}: ${v}`;

function carePlanMutationLine(m: Rec): string | undefined {
  const up = asRec(m.updates);
  switch (asStr(m.op)) {
    case "problem_add":
      return join([
        `Add problem${asStr(m.problemKind) ? ` (${words(m.problemKind)})` : ""}`,
        capText(m.description),
        labelled("ICD-10", capText(m.icd10Code, 40)),
      ]);
    case "problem_update":
      return join([
        "Update problem",
        labelled("Status", words(up.status)),
        labelled("Description", capText(up.description)),
      ]);
    case "goal_add":
      return join([
        `Add goal${asStr(m.source) ? ` (${words(m.source)})` : ""}`,
        capText(m.revisedText) ?? capText(m.originalText),
        labelled("Measurable outcome", capText(m.measurableOutcome)),
      ]);
    case "goal_update":
      return join([
        "Update goal",
        labelled("Status", words(up.status)),
        labelled("Revised", capText(up.revisedText)),
        labelled("Note", capText(up.statusNote)),
      ]);
    case "intervention_add":
      return join([
        `Add intervention${asStr(m.discipline) ? ` (${words(m.discipline)})` : ""}`,
        capText(m.scopeText),
        labelled("Frequency", capText(m.frequencyText, 200)),
      ]);
    case "intervention_discontinue":
      return join(["Discontinue intervention", labelled("Reason", capText(m.reason))]);
    default:
      return undefined;
  }
}

/** F-232 — one line per `discipline_plan_update` mutation (an M15 discipline plan, not the M7 IPOC). */
function disciplinePlanMutationLine(m: Rec): string | undefined {
  switch (asStr(m.op)) {
    case "goal_add":
      return join([
        `Add goal${asStr(m.source) ? ` (${words(m.source)})` : ""}`,
        capText(m.originalText),
        labelled("Measurable outcome", capText(m.measurableOutcome)),
      ]);
    case "goal_update":
      return join([
        `Goal: ${words(m.event) ?? "update"}`,
        labelled("Revised", capText(m.revisedText)),
        labelled("Reason", capText(m.reason)),
      ]);
    case "intervention_add":
      return join([
        `Add intervention${asStr(m.discipline) ? ` (${words(m.discipline)})` : ""}`,
        capText(m.scopeText),
        labelled("Frequency", capText(m.frequencyText, 200)),
      ]);
    case "intervention_discontinue":
      return join(["Discontinue intervention", labelled("Reason", capText(m.reason))]);
    default:
      return undefined;
  }
}

/** The plain-text lines for ONE decision payload (never throws; an unreadable payload yields no lines). */
export function summarizeDecisionPayload(kind: string, payloadRaw: unknown): string[] {
  const p = asRec(payloadRaw);
  const lines: Array<string | undefined> = [];
  const more = (total: number): void => {
    if (total > DECISION_ITEM_CAP) lines.push(`(+${total - DECISION_ITEM_CAP} more not shown)`);
  };
  switch (kind) {
    case "care_plan_update": {
      const ms = asArr(p.mutations);
      for (const m of ms.slice(0, DECISION_ITEM_CAP)) lines.push(carePlanMutationLine(asRec(m)));
      more(ms.length);
      break;
    }
    case "discipline_plan_update": {
      const ms = asArr(p.mutations);
      const plan = words(p.planKind);
      if (plan) lines.push(`${plan} revision`);
      for (const m of ms.slice(0, DECISION_ITEM_CAP)) {
        lines.push(disciplinePlanMutationLine(asRec(m)));
      }
      more(ms.length);
      break;
    }
    case "order_request": {
      const os = asArr(p.requestedOrders);
      for (const o of os.slice(0, DECISION_ITEM_CAP)) {
        const r = asRec(o);
        lines.push(
          join([
            words(r.kindHint) ?? "Order",
            capText(r.narrative),
            labelled("Timeframe", capText(r.recommendedTimeframe, 200)),
          ]),
        );
      }
      more(os.length);
      break;
    }
    case "medication_recommendation": {
      const rs = asArr(p.recommendations);
      for (const x of rs.slice(0, DECISION_ITEM_CAP)) {
        const r = asRec(x);
        lines.push(
          join([
            `${words(r.recommendationKind) ?? "Recommendation"}: ${capText(r.drugLabel, 500) ?? "(drug not stated)"}`,
            capText(r.proposedStrength, 100),
            capText(r.proposedRoute, 100),
            capText(r.proposedFrequency, 100),
            labelled("Rationale", capText(r.rationaleText)),
          ]),
        );
      }
      more(rs.length);
      break;
    }
    case "level_of_care_consideration":
      lines.push(
        join([
          `Level of care considered: ${words(p.consideredLevel) ?? "(not stated)"}`,
          labelled("Rationale", capText(p.rationaleText)),
        ]),
      );
      break;
    case "recertification_consideration":
      lines.push(
        join([
          `Recertification period: ${typeof p.periodIndex === "number" ? p.periodIndex : "(not stated)"}`,
          labelled("Rationale", capText(p.rationaleText)),
        ]),
      );
      break;
    case "family_meeting_needed": {
      const names = asArr(p.familyMembers)
        .map((n) => capText(n, 255))
        .filter((n): n is string => n !== undefined)
        .slice(0, DECISION_ITEM_CAP);
      const w = asRec(p.preferredWindow);
      const window =
        asStr(w.startIso) && asStr(w.endIso) ? `${w.startIso} to ${w.endIso}` : undefined;
      lines.push(
        join([
          "Family meeting needed",
          labelled("Family members", names.length > 0 ? names.join(", ") : undefined),
          labelled("Preferred window", window),
          labelled("Rationale", capText(p.rationaleText)),
        ]),
      );
      break;
    }
    case "bereavement_risk_flag":
      lines.push(
        join([
          `Bereavement risk: ${words(p.riskLevel) ?? "(not stated)"}`,
          labelled("Rationale", capText(p.rationaleText)),
        ]),
      );
      break;
    case "referral":
      lines.push(
        join([
          `Referral: ${capText(p.referralKind, 255) ?? "(not stated)"}`,
          labelled("Rationale", capText(p.rationaleText)),
        ]),
      );
      break;
    case "team_note":
      lines.push(capText(p.noteText));
      break;
    default:
      break;
  }
  return lines.filter((l): l is string => l !== undefined && l.length > 0);
}

const isoOf = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

/**
 * Build the `decisionContent` render block, one entry per decision in the order given. `releaseNeeded` is the
 * fail-closed Part 2 set (`patientsNeedingRelease`): a decision for such a patient is metadata-only.
 */
export function buildDecisionContent(
  rows: readonly DecisionRowInput[],
  releaseNeeded: ReadonlySet<string>,
): DecisionRenderEntry[] {
  return rows.map((d) => {
    const withheld = d.patientId !== null && releaseNeeded.has(d.patientId);
    return {
      decisionId: d.id,
      decisionKind: d.decisionKind,
      status: d.status,
      recordedAt: isoOf(d.recordedAt),
      supersededByDecisionId: d.supersededByDecisionId,
      patientId: withheld ? null : d.patientId,
      withheld,
      summary: withheld ? [] : summarizeDecisionPayload(d.decisionKind, d.payload),
    };
  });
}
