// WF09 WP3 — the web's register of the compliance gate (apps/web/src/modules/08-encounters/review/gate-register.ts) MIRRORS the server's
// (gate/checks.ts), and the blocker panel tells a clinician which checks the server decides, which it decides later, and which nothing
// decides. A check that moves in the server's register while the panel keeps the old words would show a clinician a control that is not
// there (or hide one that is). This lives with the backend's tests, importing the web's pure leaf by path (a SPA never imports the
// backend, ADR-0032; a backend test may read the SPA's pure leaf, as note-closure-allowlist-mirror.test.ts does).
//
// Four things are held (the fourth, below, keys the web's words to the checks and numbers the server's code actually has):
//   1. the web lists exactly the server's checks, with the same ordinals;
//   2. the web's kind agrees with the server's state: evaluated = finalize_gate, deferred = not_evaluated, elsewhere = enforced_elsewhere,
//      with ONE named exception: check 9 (the attestation), which the server lists as enforced by the route schema but never records;
//   3. the exception is pinned from the other side. The panel says "the server does not record this acknowledgment". The day a column or
//      a service starts recording it, this fails, and the web's copy and kind have to be reviewed in the same change.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schema } from "@chartwarden/db";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  type CheckKind,
  GATE_REGISTER,
} from "../../web/src/modules/08-encounters/review/gate-register";
import { CHECK_BY_CODE } from "../../web/src/modules/08-encounters/review/refusal-model";
import { ACTION_CODE } from "../src/modules/08-encounters/drafting/section-state";
import { GATE_CHECKS, type GateCheckId } from "../src/modules/08-encounters/gate/checks";
import { LATE_ENTRY_TIER_DAY_CEILINGS } from "../src/modules/08-encounters/late-entry/tiers";
import {
  STEP_UP_MAX_AGE_SECONDS,
  TEXT_MINIMUMS,
} from "../src/modules/08-encounters/lifecycle/validation";

const here = dirname(fileURLToPath(import.meta.url));
const m8 = join(here, "..", "src", "modules", "08-encounters");
const webReview = join(here, "..", "..", "web", "src", "modules", "08-encounters", "review");

const serverIds = Object.keys(GATE_CHECKS) as GateCheckId[];

/** The one check the server lists as enforced elsewhere that the web calls unrecorded, and why. */
const UNRECORDED_ON_THE_SERVER: ReadonlySet<string> = new Set(["attestation_confirmed"]);

function webKindFor(serverKind: "evaluated" | "deferred" | "elsewhere", id: string): CheckKind {
  if (serverKind === "evaluated") return "finalize_gate";
  if (serverKind === "deferred") return "not_evaluated";
  return UNRECORDED_ON_THE_SERVER.has(id) ? "unrecorded" : "enforced_elsewhere";
}

describe("the web gate register mirrors the server's", () => {
  it("lists exactly the server's checks, by id and ordinal", () => {
    expect(GATE_REGISTER.map((check) => check.id).sort()).toEqual([...serverIds].sort());
    for (const check of GATE_REGISTER) {
      expect(check.ordinal, check.id).toBe(GATE_CHECKS[check.id as GateCheckId].ordinal);
    }
  });

  it("agrees with the server's state for every check", () => {
    for (const check of GATE_REGISTER) {
      const server = GATE_CHECKS[check.id as GateCheckId];
      expect(check.kind, check.id).toBe(webKindFor(server.state.kind, check.id));
    }
  });

  it("groups a check as not checked exactly when nothing decides it or nothing records it", () => {
    for (const check of GATE_REGISTER) {
      const notChecked = check.kind === "not_evaluated" || check.kind === "unrecorded";
      expect(check.group === "not_checked", check.id).toBe(notChecked);
    }
  });

  it("keeps the web's unrecorded exception on a check the server lists as enforced elsewhere", () => {
    for (const id of UNRECORDED_ON_THE_SERVER) {
      expect(GATE_CHECKS[id as GateCheckId].state.kind).toBe("elsewhere");
    }
  });
});

describe("the acknowledgment is still not recorded on the server", () => {
  it("has no column on the signature row for the acknowledgment, only the stamped text", () => {
    const attestationColumns = Object.keys(getTableColumns(schema.encounterSignatures)).filter(
      (name) => /attest|acknowledg/i.test(name),
    );
    expect(attestationColumns).toEqual(["attestationText"]);
  });

  it("never reads the client's acknowledgment in the services that sign", () => {
    for (const file of [
      "encounters-route-service-db.ts",
      join("cosignature", "db-cosignature.ts"),
    ]) {
      const source = readFileSync(join(m8, file), "utf8");
      expect(source, file).not.toMatch(/attestationConfirmed/);
    }
  });
});

describe("the web's words are keyed to what the server's gate and late-entry rules really do", () => {
  const gateSource = readFileSync(join(m8, "gate", "gate.ts"), "utf8");
  const raisedBy: ReadonlyMap<string, string> = new Map([
    ...[...gateSource.matchAll(/check:\s*"([a-z0-9_]+)",\s*code:\s*"([A-Z0-9_]+)"/g)].map(
      (match): [string, string] => [match[2] as string, match[1] as string],
    ),
    // The drafted-section codes are named through the action table, not written beside their check.
    ...Object.values(ACTION_CODE).map((code): [string, string] => [
      code,
      "draft_sections_resolved",
    ]),
  ]);
  const description = (id: GateCheckId): string =>
    GATE_REGISTER.find((check) => check.id === id)?.description ?? "";

  it("reads the codes the gate raises from its source, so this cannot pass by reading nothing", () => {
    for (const code of [
      "MISSING_SECTION",
      "NO_TEMPLATE_FOR_PAIR",
      "MISSING_VITAL",
      "MISSING_SCALE",
      "CARE_PLAN_REVIEW_OVERDUE",
      "DRAFT_SECTION_UNRESOLVED",
      "DRAFT_SECTION_STALE",
    ]) {
      expect(raisedBy.has(code), code).toBe(true);
    }
  });

  it("words every code the encounter gate raises, and files each under the check the gate raises it from", () => {
    for (const [code, check] of raisedBy) {
      // An addendum's own refusal is not a visit note's; the blocker panel is the encounter's.
      if (code === "ADDENDUM_EMPTY") continue;
      expect(CHECK_BY_CODE.has(code), `${code} has no words`).toBe(true);
      expect(CHECK_BY_CODE.get(code), code).toBe(check);
    }
  });

  it("keeps every register check a code is filed under in the server's own register", () => {
    for (const [code, check] of CHECK_BY_CODE) {
      if (check !== null) expect(GATE_CHECKS[check as GateCheckId], code).toBeDefined();
    }
  });

  it("judges the late-entry reason at finalize, before the gate runs, and the override at sign, as the web says", () => {
    const source = readFileSync(join(m8, "encounters-route-service-db.ts"), "utf8");
    const finalize = source.slice(source.indexOf("async finalize(organizationId"));
    expect(finalize.indexOf("resolveLateEntry({")).toBeGreaterThan(-1);
    expect(finalize.indexOf("resolveLateEntry({")).toBeLessThan(
      finalize.indexOf('gateEncounter(t, r, "finalize"'),
    );
    expect(finalize.slice(0, finalize.indexOf('gateEncounter(t, r, "finalize"'))).toContain(
      "requireOverride: false",
    );
    const signAt = source.indexOf("// GAP-013 §2.5 — the tier is recomputed at SIGN");
    expect(signAt).toBeGreaterThan(-1);
    const sign = source.slice(signAt);
    expect(sign.indexOf('gateEncounter(t, r, "sign"')).toBeGreaterThan(-1);
    expect(sign.slice(0, sign.indexOf('gateEncounter(t, r, "sign"'))).toContain(
      "requireOverride: true",
    );
    expect(GATE_REGISTER.find((check) => check.id === "late_entry_ceiling")?.group).toBe(
      "finalize",
    );
  });

  it("says the late-entry thresholds in the server's own whole calendar days and minimum length", () => {
    const {
      normal,
      late_entry: late,
      significant_late_entry: significant,
    } = LATE_ENTRY_TIER_DAY_CEILINGS;
    const text = description("late_entry_ceiling");
    expect(text).toContain(`more than ${normal} calendar day after the visit date`);
    expect(text).toContain(`a note more than ${late} days late`);
    expect(text).toContain(`more than ${significant} days late by a director`);
    expect(text).toContain(`reason of at least ${TEXT_MINIMUMS.lateEntryReason} characters`);
    const field = readFileSync(join(webReview, "late-entry-reason-field.tsx"), "utf8");
    expect(field).toContain(`LATE_ENTRY_REASON_MIN = ${TEXT_MINIMUMS.lateEntryReason};`);
  });

  it("says the step-up window in the server's own minutes", () => {
    expect(description("step_up_fresh")).toContain(`${STEP_UP_MAX_AGE_SECONDS / 60} minutes`);
  });

  it("says the face-to-face check is a link that must already exist, as the sign's own guard reads it", () => {
    const f2f = readFileSync(join(m8, "authoring", "f2f.ts"), "utf8");
    expect(f2f).toContain("f2fDualWriteSatisfied: facts.faceToFaceEncounterId !== null");
    expect(description("f2f_attested")).toContain("already be linked");
  });
});
