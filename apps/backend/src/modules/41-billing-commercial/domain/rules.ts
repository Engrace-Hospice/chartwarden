// apps/backend/src/modules/41-billing-commercial/domain/rules.ts — PURE payer-specific edit rules for a commercial hospice
// claim (issue #722, ADR-0100 D6/D9). No I/O, no clock: the caller loads the facts, this decides.
//
// Severity vocabulary (mirrors the M23 hard-block / audited-override split):
//   error  a HARD BLOCK. `overridable` is false: no role can move the claim past it; only a data or policy change can.
//   warn   a SOFT BLOCK. `overridable` is true: it blocks until a permitted person overrides it with a reason (audited).
//   info   never blocks.
// Evidence holds ids, dates and codes only (no patient, member or authorization number): it is hashed so an override binds
// to the exact facts it was granted for, and it is persisted next to the result.
import { createHash } from "node:crypto";
import {
  COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES,
  type CommercialAuthorizationRequirement,
  type CommercialHospiceLevelOfCare,
  type CommercialSecondaryPayerKind,
  type CommercialValidationOutcome,
  type CommercialValidationSeverity,
} from "@chartwarden/types";
import { addDays, eachDay, toRanges } from "./dates";
import type { PricedLine, UnpricedReason } from "./pricing";

/** Bump when a rule's meaning changes; stored on every run. */
export const COMMERCIAL_RULE_SET_VERSION = 1;

export interface PlanFact {
  readonly id: string;
  readonly payerId: string;
  readonly claimFilingIndicator: string;
  readonly authorizationRequirement: CommercialAuthorizationRequirement;
  readonly authorizationLeadDays: number | null;
  readonly siteOfServiceHcpcsRequired: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface PayerStateFact {
  readonly status: string;
  readonly mergedIntoId: string | null;
}

export interface RouteFact {
  readonly clearinghouseKey: string;
  readonly clearinghousePayerId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface AuthorizationFact {
  readonly id: string;
  readonly levelOfCare: CommercialHospiceLevelOfCare | null;
  readonly status: string;
  readonly obtainedOn: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface RuleContext {
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly plan: PlanFact;
  readonly payerState: PayerStateFact | null;
  /** The plan's routes; `clearinghouseKey` narrows them to the active clearinghouse when one is known. */
  readonly routes: readonly RouteFact[];
  readonly clearinghouseKey: string | null;
  readonly lines: readonly PricedLine[];
  readonly authorizations: readonly AuthorizationFact[];
  readonly diagnosisCodes: readonly string[];
  readonly attendingNpi: string | null;
  readonly secondaryPayerKind: CommercialSecondaryPayerKind | null;
}

export interface RuleOutcome {
  readonly ruleKey: string;
  readonly severity: CommercialValidationSeverity;
  readonly outcome: CommercialValidationOutcome;
  readonly overridable: boolean;
  readonly message: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

const pass = (ruleKey: string, message: string): RuleOutcome => ({
  ruleKey,
  severity: "info",
  outcome: "pass",
  overridable: false,
  message,
  evidence: {},
});

const hardFail = (
  ruleKey: string,
  message: string,
  evidence: Record<string, unknown>,
): RuleOutcome => ({
  ruleKey,
  severity: "error",
  outcome: "fail",
  overridable: false,
  message,
  evidence,
});

const softFail = (
  ruleKey: string,
  message: string,
  evidence: Record<string, unknown>,
): RuleOutcome => ({
  ruleKey,
  severity: "warn",
  outcome: "fail",
  overridable: true,
  message,
  evidence,
});

/** sha256 of the canonical (key-sorted) JSON of the evidence. */
export function evidenceHash(evidence: Readonly<Record<string, unknown>>): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(evidence)))
    .digest("hex");
}

const covers = (p: { effectiveFrom: string; effectiveTo: string | null }, day: string): boolean =>
  p.effectiveFrom <= day && (p.effectiveTo === null || p.effectiveTo >= day);

// ── rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The statement period and the lines must agree: every day of the window is billed exactly once. A hole in the level-of-care
 * periods would otherwise save an under-billed claim, and overlapping periods would double-bill a day.
 */
function serviceDaysCovered(c: RuleContext): RuleOutcome {
  const key = "service_days_covered";
  const counts = new Map<string, number>();
  for (const l of c.lines)
    for (const d of eachDay(l.serviceFrom, l.serviceTo)) counts.set(d, (counts.get(d) ?? 0) + 1);
  const window = eachDay(c.serviceFrom, c.serviceTo);
  const missing = window.filter((d) => !counts.has(d));
  const doubled = window.filter((d) => (counts.get(d) ?? 0) > 1);
  const outside = [...counts.keys()].filter((d) => d < c.serviceFrom || d > c.serviceTo);
  if (missing.length === 0 && doubled.length === 0 && outside.length === 0) {
    return pass(key, "Every day of the service window is billed exactly once.");
  }
  const text = (label: string, days: string[]): string =>
    days.length === 0
      ? ""
      : ` ${label} ${toRanges([...days].sort())
          .map((r) => `${r.from} to ${r.to}`)
          .join(", ")}.`;
  return hardFail(
    key,
    `The lines do not match the service window ${c.serviceFrom} to ${c.serviceTo}.${text("Not billed:", missing)}${text("Billed twice:", doubled)}${text("Outside the window:", outside)} Correct the level-of-care periods for the stay, void this claim and assemble again.`,
    {
      missing: toRanges(missing),
      doubled: toRanges(doubled),
      outside: toRanges([...outside].sort()),
    },
  );
}

function planInEffect(c: RuleContext): RuleOutcome {
  const key = "plan_in_effect";
  const ok = covers(c.plan, c.serviceFrom) && covers(c.plan, c.serviceTo);
  return ok
    ? pass(key, "The payer plan is in effect for the whole service window.")
    : hardFail(
        key,
        `The payer plan is in effect ${c.plan.effectiveFrom} to ${c.plan.effectiveTo ?? "open"}, which does not cover the service window ${c.serviceFrom} to ${c.serviceTo}. Extend the plan or end this claim at the plan boundary.`,
        {
          planFrom: c.plan.effectiveFrom,
          planTo: c.plan.effectiveTo,
          serviceFrom: c.serviceFrom,
          serviceTo: c.serviceTo,
        },
      );
}

function planPayerActive(c: RuleContext): RuleOutcome {
  const key = "plan_payer_active";
  const state = c.payerState;
  if (state === null) {
    return hardFail(
      key,
      "The plan's payer is not in the payer master. Re-point the plan to an active payer.",
      {
        payerId: c.plan.payerId,
        status: "missing",
      },
    );
  }
  if (state.status === "active") return pass(key, "The plan's payer is active.");
  const survivor = state.mergedIntoId
    ? ` It was merged into payer ${state.mergedIntoId}: end this plan and create the plan on the surviving payer.`
    : " End this plan or re-activate the payer.";
  return hardFail(key, `The plan's payer is ${state.status}.${survivor}`, {
    payerId: c.plan.payerId,
    status: state.status,
    mergedIntoId: state.mergedIntoId,
  });
}

function filingIndicatorCommercial(c: RuleContext): RuleOutcome {
  const key = "claim_filing_indicator_commercial";
  return (COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES as readonly string[]).includes(
    c.plan.claimFilingIndicator,
  )
    ? pass(key, "The claim filing indicator is a commercial code.")
    : hardFail(
        key,
        `Claim filing indicator ${c.plan.claimFilingIndicator} is not a commercial code. Medicare and Medicaid claims belong to Module 23 and Module 24.`,
        { claimFilingIndicator: c.plan.claimFilingIndicator },
      );
}

function payerRouteInEffect(c: RuleContext): RuleOutcome {
  const key = "payer_route_in_effect";
  const candidates = c.routes.filter(
    (r) => c.clearinghouseKey === null || r.clearinghouseKey === c.clearinghouseKey,
  );
  const inEffect = candidates.filter((r) => covers(r, c.serviceTo));
  const keys = [...new Set(inEffect.map((r) => r.clearinghouseKey))];
  if (keys.length === 1) return pass(key, "A clearinghouse payer id is in effect for this plan.");
  if (keys.length > 1) {
    return hardFail(
      key,
      `Plan routes are in effect on more than one clearinghouse (${keys.sort().join(", ")}) and no active clearinghouse was named. Name the clearinghouse the claim goes through.`,
      { clearinghouses: keys.sort(), serviceTo: c.serviceTo },
    );
  }
  return hardFail(
    key,
    `No clearinghouse payer id is in effect for this plan on ${c.serviceTo}${c.clearinghouseKey ? ` for ${c.clearinghouseKey}` : ""}. Add or extend the plan's payer route.`,
    { clearinghouse: c.clearinghouseKey, serviceTo: c.serviceTo },
  );
}

const UNPRICED_TEXT: Record<UnpricedReason, string> = {
  no_contract_rate: "no contract rate is in effect",
  percent_of_charges_needs_charge_source:
    "the contract is percent-of-charges and no standard charge source exists to price it",
  chc_hours_not_documented: "per-hour continuous care needs whole documented hours for the period",
};

function ratesAndCharges(c: RuleContext): RuleOutcome[] {
  const unpriced = c.lines.filter((l) => l.unpricedReason !== null);
  const noRate = unpriced.filter((l) => l.unpricedReason === "no_contract_rate");
  const other = unpriced.filter((l) => l.unpricedReason !== "no_contract_rate");
  const seg = (l: PricedLine) => ({
    levelOfCare: l.levelOfCare,
    from: l.serviceFrom,
    to: l.serviceTo,
    reason: l.unpricedReason,
  });
  return [
    noRate.length === 0
      ? pass("contract_rate_in_effect", "A contract rate is in effect for every billed day.")
      : hardFail(
          "contract_rate_in_effect",
          `No contract rate is in effect for ${noRate.map((l) => `${l.levelOfCare} ${l.serviceFrom} to ${l.serviceTo}`).join("; ")}. Add the rate to the plan's contract terms.`,
          { segments: noRate.map(seg) },
        ),
    other.length === 0
      ? pass("charge_priceable", "Every line is priceable from the contract.")
      : hardFail(
          "charge_priceable",
          `Cannot price ${other.map((l) => `${l.levelOfCare} ${l.serviceFrom} to ${l.serviceTo} (${UNPRICED_TEXT[l.unpricedReason as UnpricedReason]})`).join("; ")}.`,
          { segments: other.map(seg) },
        ),
  ];
}

function diagnosisAndAttending(c: RuleContext): RuleOutcome[] {
  return [
    c.diagnosisCodes.length > 0
      ? pass("principal_diagnosis_present", "A principal diagnosis is on the claim.")
      : hardFail(
          "principal_diagnosis_present",
          "The claim has no ICD-10 diagnosis. Record the terminal diagnosis for the patient before billing.",
          { diagnosisCount: 0 },
        ),
    c.attendingNpi !== null
      ? pass("attending_physician_present", "An attending physician NPI is on the claim.")
      : hardFail(
          "attending_physician_present",
          "No attending physician with a valid NPI is recorded for this stay. The 837I requires one.",
          { attendingNpi: null },
        ),
    !c.plan.siteOfServiceHcpcsRequired || c.lines.every((l) => l.hcpcsCode !== null)
      ? pass("site_of_service_hcpcs", "Line procedure codes match the plan's requirement.")
      : hardFail(
          "site_of_service_hcpcs",
          "This plan requires a site-of-service HCPCS code on every line but the patient's place of service is not recorded. Record the place of service.",
          { lines: c.lines.filter((l) => l.hcpcsCode === null).map((l) => l.lineNumber) },
        ),
  ];
}

// ── pre-authorization ─────────────────────────────────────────────────────────────────────────────────────────

function approvedAuths(c: RuleContext): AuthorizationFact[] {
  return c.authorizations.filter((a) => a.status === "approved");
}

/** The billed days (with their level of care) that no approved authorization covers. */
function uncoveredDays(
  c: RuleContext,
): { levelOfCare: CommercialHospiceLevelOfCare; day: string }[] {
  const perLevel = c.plan.authorizationRequirement === "required_per_level_of_care";
  const auths = approvedAuths(c);
  const out: { levelOfCare: CommercialHospiceLevelOfCare; day: string }[] = [];
  for (const line of c.lines) {
    for (const day of eachDay(line.serviceFrom, line.serviceTo)) {
      const ok = auths.some(
        (a) =>
          covers(a, day) &&
          (perLevel
            ? a.levelOfCare === line.levelOfCare
            : a.levelOfCare === null || a.levelOfCare === line.levelOfCare),
      );
      if (!ok) out.push({ levelOfCare: line.levelOfCare, day });
    }
  }
  return out;
}

function authorizationOnFile(c: RuleContext): RuleOutcome {
  const key = "authorization_on_file";
  const requirement = c.plan.authorizationRequirement;
  if (requirement === "not_required")
    return pass(key, "The plan does not require pre-authorization.");
  const gaps = uncoveredDays(c);
  if (gaps.length === 0) return pass(key, "Pre-authorization covers every billed day.");
  const byLevel = [...new Set(gaps.map((g) => g.levelOfCare))].sort();
  const ranges = byLevel.map((levelOfCare) => ({
    levelOfCare,
    ranges: toRanges(
      gaps
        .filter((g) => g.levelOfCare === levelOfCare)
        .map((g) => g.day)
        .sort(),
    ),
  }));
  const approved = approvedAuths(c);
  const lastEnd = approved
    .map((a) => a.effectiveTo)
    .filter((d): d is string => d !== null)
    .sort()
    .pop();
  const expired = approved.length > 0 && lastEnd !== undefined && gaps.some((g) => g.day > lastEnd);
  const where = ranges
    .map((r) => `${r.levelOfCare} ${r.ranges.map((x) => `${x.from} to ${x.to}`).join(", ")}`)
    .join("; ");
  const evidence = { requirement, uncovered: ranges, latestAuthorizationEnd: lastEnd ?? null };
  if (requirement === "confirm_with_payer") {
    return softFail(
      key,
      `Whether this plan needs pre-authorization is unconfirmed and none covers ${where}. Record the authorization, or confirm with the payer that none is needed and override with the reason.`,
      evidence,
    );
  }
  return hardFail(
    key,
    expired
      ? `Pre-authorization expired before ${where}. Obtain and record an extension, then re-validate.`
      : `Pre-authorization is required and none covers ${where}. Obtain and record the authorization, then re-validate.`,
    evidence,
  );
}

function authorizationLeadTime(c: RuleContext): RuleOutcome {
  const key = "authorization_lead_time";
  const lead = c.plan.authorizationLeadDays;
  if (lead === null || c.plan.authorizationRequirement === "not_required") {
    return pass(key, "The plan sets no authorization lead time.");
  }
  const first = c.lines.map((l) => l.serviceFrom).sort()[0];
  if (first === undefined) return pass(key, "No billed days.");
  const late = approvedAuths(c).filter(
    (a) => covers(a, first) && a.obtainedOn > addDays(first, -lead),
  );
  const timely = approvedAuths(c).some(
    (a) => covers(a, first) && a.obtainedOn <= addDays(first, -lead),
  );
  if (late.length === 0 || timely)
    return pass(key, "Authorization was obtained within the plan's lead time.");
  const worst = late
    .map((a) => a.obtainedOn)
    .sort()
    .pop() as string;
  return softFail(
    key,
    `The plan expects authorization ${lead} days before service; the authorization covering ${first} was obtained on ${worst}. Override with the reason if the payer accepted it.`,
    { leadDays: lead, firstServiceDay: first, obtainedOn: worst },
  );
}

function coordinationOfBenefits(c: RuleContext): RuleOutcome {
  const key = "cob_secondary_declared";
  return c.secondaryPayerKind === null
    ? pass(key, "No secondary payer is recorded.")
    : {
        ruleKey: key,
        severity: "info",
        outcome: "info",
        overridable: false,
        message: `${c.secondaryPayerKind === "medicare" ? "Medicare" : "Medicaid"} is recorded as secondary. The claim carries the other-payer loop; no ${c.secondaryPayerKind === "medicare" ? "Medicare" : "Medicaid"} claim is created as primary.`,
        evidence: { secondaryPayerKind: c.secondaryPayerKind },
      };
}

/** Run every rule over the facts. Deterministic and total. */
export function runCommercialRules(c: RuleContext): RuleOutcome[] {
  return [
    planInEffect(c),
    planPayerActive(c),
    filingIndicatorCommercial(c),
    payerRouteInEffect(c),
    ...ratesAndCharges(c),
    serviceDaysCovered(c),
    ...diagnosisAndAttending(c),
    authorizationOnFile(c),
    authorizationLeadTime(c),
    coordinationOfBenefits(c),
  ];
}

/** A result blocks the claim unless it passed, is informational, or an override exists for the same facts. */
export function isBlocking(
  r: Pick<RuleOutcome, "outcome" | "severity">,
  overridden: boolean,
): boolean {
  return r.outcome === "fail" && r.severity !== "info" && !overridden;
}
