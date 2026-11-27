// CW-AC-46 — the per-organization enforcement mode of the signer-licence check, without a database: the validation a PUT takes
// (shadow needs a reason of 20-200 characters, screened for patient identifiers; enforce takes none), the default (enforce), and the
// pins that keep the code, the database enum and the migration in step. The table, the audit rows and the sign paths are proven live
// (`m10-hope-signer-licence.live.test.ts`); the routes in `hope-signer-licence-policy-routes.test.ts`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { M10_CONTRIBUTED_PERMISSIONS } from "@chartwarden/auth";
import { schema } from "@chartwarden/db";
import {
  ChartWardenError,
  HOPE_SIGNER_LICENCE_DEFAULT_MODE,
  HOPE_SIGNER_LICENCE_MODES,
  HOPE_SIGNER_LICENCE_SHADOW_REASON_MAX,
  HOPE_SIGNER_LICENCE_SHADOW_REASON_MIN,
  ValidationError,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { fullCatalogGrantRows } from "../../../scripts/db/lib/full-catalog-grants";
import {
  HopeSignerLicenceRefusal,
  applySignerLicence,
  signerLicenceRefusal,
} from "../src/modules/10-hope/hope-signer-licence";
import {
  DEFAULT_SIGNER_LICENCE_POLICY,
  putSignerLicencePolicy,
  validateSignerLicencePolicyInput,
} from "../src/modules/10-hope/hope-signer-licence-policy";
import { scriptedDb } from "./_hope-g3-fake-db";

const REASON = "Rollout window: back-filling the clinicians' licences before enforcing";
const failure = (mode: string, reason?: string): unknown => {
  try {
    validateSignerLicencePolicyInput({
      mode: mode as "enforce" | "shadow",
      ...(reason !== undefined ? { reason } : {}),
    });
    return null;
  } catch (error) {
    return error;
  }
};

describe("the default", () => {
  it("is enforce, never configured: compliant by default", () => {
    expect(HOPE_SIGNER_LICENCE_DEFAULT_MODE).toBe("enforce");
    expect(DEFAULT_SIGNER_LICENCE_POLICY).toEqual({
      mode: "enforce",
      reason: null,
      configuredAt: null,
    });
  });

  it("the database enum, the migration and the code list the same two modes and the same reason bounds", () => {
    expect([...schema.hopeSignerLicencePolicies.mode.enumValues]).toEqual([
      ...HOPE_SIGNER_LICENCE_MODES,
    ]);
    const migration = readFileSync(
      join(__dirname, "../../../packages/db/migrations/1587_m10_hope_signer_licence_policy.sql"),
      "utf8",
    );
    expect(migration.split("\n")[0]).toBe("-- compat: expand");
    expect(migration).toContain("ENUM ('enforce', 'shadow')");
    expect(migration).toContain(
      `BETWEEN ${HOPE_SIGNER_LICENCE_SHADOW_REASON_MIN} AND ${HOPE_SIGNER_LICENCE_SHADOW_REASON_MAX}`,
    );
    expect(migration).toContain("DEFAULT 'enforce'");
  });
});

describe("validateSignerLicencePolicyInput", () => {
  it("enforce takes no reason: none is `null`, a blank one is none, a real one is refused (422)", () => {
    expect(validateSignerLicencePolicyInput({ mode: "enforce" })).toBeNull();
    expect(validateSignerLicencePolicyInput({ mode: "enforce", reason: "   " })).toBeNull();
    expect(failure("enforce", REASON)).toBeInstanceOf(ValidationError);
    expect(failure("enforce", REASON)).toMatchObject({ statusCode: 422 });
  });

  it("shadow REQUIRES a reason of 20-200 characters once trimmed, and returns it trimmed", () => {
    expect(failure("shadow")).toBeInstanceOf(ValidationError);
    expect(failure("shadow", "          ")).toBeInstanceOf(ValidationError);
    expect(failure("shadow", "x".repeat(19))).toBeInstanceOf(ValidationError);
    expect(failure("shadow", "x".repeat(201))).toBeInstanceOf(ValidationError);
    expect(validateSignerLicencePolicyInput({ mode: "shadow", reason: "x".repeat(20) })).toBe(
      "x".repeat(20),
    );
    expect(validateSignerLicencePolicyInput({ mode: "shadow", reason: "x".repeat(200) })).toBe(
      "x".repeat(200),
    );
    expect(validateSignerLicencePolicyInput({ mode: "shadow", reason: `  ${REASON}\n` })).toBe(
      REASON,
    );
  });

  it("counts characters, not bytes or UTF-16 units (20 astral characters are 20)", () => {
    const astral = "😀".repeat(20);
    expect(validateSignerLicencePolicyInput({ mode: "shadow", reason: astral })).toBe(astral);
  });

  it("screens the reason for patient identifiers: it enters an immutable trail", () => {
    const refused = failure(
      "shadow",
      "Rollout window while the roster of SSN 900-12-3456 is entered",
    );
    expect(refused).toBeInstanceOf(ChartWardenError);
    expect(refused).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect((refused as Error).message).not.toContain("900-12-3456"); // the refusal never echoes the value
  });

  it("refuses a mode that is neither enforce nor shadow", () => {
    expect(failure("off", REASON)).toBeInstanceOf(ValidationError);
  });
});

describe("the reason must be readable plain text", () => {
  it.each([
    ["twenty zero-width spaces", "​".repeat(20)],
    ["a reason made of one letter, eighteen spaces and one letter", `a${" ".repeat(18)}b`],
    ["a reason with a NUL character", `Rollout window\u0000 while the roster is entered`],
    ["a reason with a lone surrogate", `Rollout window\ud800 while the roster is entered`],
    ["a reason with a bidi override", `Rollout window‮ while the roster is entered`],
  ])("refuses %s (422)", (_name, reason) => {
    expect(failure("shadow", reason)).toBeInstanceOf(ValidationError);
  });

  it("accepts a multi-line reason (tab, line feed and carriage return are text)", () => {
    const reason = `Rollout window:\n\tback-filling the licences\r\nbefore enforcing`;
    expect(validateSignerLicencePolicyInput({ mode: "shadow", reason })).toBe(reason);
  });
});

describe("applySignerLicence: the verdict under each mode, against a scripted transaction", () => {
  const caller = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    membershipId: "33333333-3333-4333-8333-333333333333",
    request: { actorUserId: "44444444-4444-4444-8444-444444444444" },
  };
  const resource = { kind: "hope_assessment", id: "55555555-5555-4555-8555-555555555555" } as const;
  const record = { authorDiscipline: "RN", rfaKind: "01_admission" };
  const licensed = { membershipId: caller.membershipId, asOf: "2026-11-27", heldKinds: ["rn"] };
  const unlicensed = { membershipId: caller.membershipId, asOf: "2026-11-27", heldKinds: [] };

  /** The rows an `insert(...).values(row)` was given, in order (the audit rows and nothing else in these scripts). */
  function inserts(fake: ReturnType<typeof scriptedDb>): Record<string, unknown>[] {
    const rows: Record<string, unknown>[] = [];
    const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
    const original = tx.insert as (...a: unknown[]) => Record<string, unknown>;
    tx.insert = (...args: unknown[]) => {
      const link = original(...args);
      const values = link.values as (a?: unknown) => unknown;
      link.values = (argument?: unknown) => {
        rows.push(argument as Record<string, unknown>);
        return values(argument);
      };
      return link;
    };
    return rows;
  }
  const policyRow = (mode: string) => [{ mode, reason: null, configuredAt: new Date() }];

  it("a licensed signer: nothing happens and the policy is never read", async () => {
    const fake = scriptedDb([]);

    await applySignerLicence(fake.tx, caller, resource, licensed, record, "timepoint_sign");

    expect(fake.statements).toEqual([]);
  });

  it.each([
    ["an organization with no row", []],
    ["an organization in enforce", policyRow("enforce")],
    [
      "a mode this code does not know (fail safe: only the exact value `shadow` lets a signature through)",
      policyRow("future_mode"),
    ],
  ])(
    "an unlicensed signer is REFUSED for %s: thrown, one policy read, nothing written",
    async (_name, rows) => {
      const fake = scriptedDb([rows]);
      const written = inserts(fake);

      const failure = await applySignerLicence(
        fake.tx,
        caller,
        resource,
        unlicensed,
        record,
        "timepoint_sign",
      ).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(HopeSignerLicenceRefusal);
      expect(failure).toMatchObject({ code: "M10_SIGNER_LICENCE_NOT_ACTIVE", statusCode: 403 });
      expect(fake.statements.map((s) => s.kind)).toEqual(["select"]);
      expect(written).toEqual([]);
    },
  );

  it("an unlicensed signer in SHADOW goes through: no throw, and the finding is written on this transaction (mode shadow, outcome success)", async () => {
    const fake = scriptedDb([policyRow("shadow"), []]);
    const written = inserts(fake);

    await applySignerLicence(fake.tx, caller, resource, unlicensed, record, "timepoint_sign");

    expect(fake.statements.map((s) => s.kind)).toEqual(["select", "insert"]);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      eventType: "m10.signature.licence_refused",
      outcome: "success",
      severity: "warn",
      resourceKind: "hope_assessment",
      resourceId: resource.id,
      context: {
        mode: "shadow",
        errorCode: "M10_SIGNER_LICENCE_NOT_ACTIVE",
        operation: "timepoint_sign",
        reason: "no_active_licence",
        requiredDiscipline: "RN",
        heldLicenceKinds: [],
        byMembershipId: caller.membershipId,
      },
    });
  });

  it("a policy that cannot be read fails the transaction (nothing is signed, nothing is written)", async () => {
    const fake = scriptedDb([new Error("policy table unreachable")]);
    const written = inserts(fake);

    const failure = await applySignerLicence(
      fake.tx,
      caller,
      resource,
      unlicensed,
      record,
      "timepoint_sign",
    ).catch((e: unknown) => e);

    expect(failure).toMatchObject({ message: "policy table unreachable" });
    expect(written).toEqual([]);
  });

  it("in shadow a finding that cannot be written fails the signature (shadow records, it does not skip the audit)", async () => {
    const fake = scriptedDb([policyRow("shadow"), new Error("audit insert failed")]);

    const failure = await applySignerLicence(
      fake.tx,
      caller,
      resource,
      unlicensed,
      record,
      "timepoint_sign",
    ).catch((e: unknown) => e);

    expect(failure).toMatchObject({ message: "audit insert failed" });
  });
});

describe("putSignerLicencePolicy against a scripted transaction", () => {
  const input = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    membershipId: "33333333-3333-4333-8333-333333333333",
    actorUserId: "44444444-4444-4444-8444-444444444444",
  };

  it("writes the row and the change event together: previous mode, new mode, the trimmed reason, the operator", async () => {
    const fake = scriptedDb([[], [], []]); // previous policy (none), the upsert, the audit event
    const rows: Record<string, unknown>[] = [];
    const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
    const original = tx.insert as (...a: unknown[]) => Record<string, unknown>;
    tx.insert = (...args: unknown[]) => {
      const link = original(...args);
      const values = link.values as (a?: unknown) => unknown;
      link.values = (argument?: unknown) => {
        rows.push(argument as Record<string, unknown>);
        return values(argument);
      };
      return link;
    };

    const set = await putSignerLicencePolicy(fake.tx, {
      ...input,
      mode: "shadow",
      reason: `  ${REASON}  `,
    });

    expect(set).toMatchObject({ mode: "shadow", reason: REASON });
    expect(fake.statements.map((s) => s.kind)).toEqual(["select", "insert", "insert"]);
    expect(rows[0]).toMatchObject({
      organizationId: input.organizationId,
      mode: "shadow",
      shadowReason: REASON,
      configuredByUserId: input.actorUserId,
    });
    expect(rows[1]).toMatchObject({
      eventType: "m10.signature.licence_policy_changed",
      outcome: "success",
      severity: "warn",
      resourceKind: "organization",
      resourceId: input.organizationId,
      context: {
        previousMode: "enforce",
        mode: "shadow",
        justification: REASON,
        byMembershipId: input.membershipId,
      },
    });
  });

  it("validates before any statement: a refused request never touches the database", async () => {
    const fake = scriptedDb([]);

    const failure = await putSignerLicencePolicy(fake.tx, { ...input, mode: "shadow" }).catch(
      (e: unknown) => e,
    );

    expect(failure).toBeInstanceOf(ValidationError);
    expect(fake.statements).toEqual([]);
  });
});

describe("the key that lowers the check is no tenant role's default", () => {
  it("is a platform-category key (withheld from the tenant materializer) and is withheld from the seed scripts' full-catalog grants", () => {
    expect(M10_CONTRIBUTED_PERMISSIONS["hope.admin.signer_licence_policy"].category).toBe(
      "platform",
    );
    const rows = [{ key: "hope.admin.signer_licence_policy" }, { key: "hope.timepoint.sign" }];
    expect(fullCatalogGrantRows(rows)).toEqual([{ key: "hope.timepoint.sign" }]);
  });
});

describe("signerLicenceRefusal (the pure verdict both modes share)", () => {
  const held = (...heldKinds: string[]) => ({
    membershipId: "33333333-3333-4333-8333-333333333333",
    asOf: "2026-11-27",
    heldKinds,
  });

  it("is null for a signer who holds the licence, and the refusal to throw or to record for one who does not", () => {
    const rn = { authorDiscipline: "RN", rfaKind: "01_admission" };
    expect(signerLicenceRefusal(held("rn"), rn, "timepoint_sign")).toBeNull();
    expect(signerLicenceRefusal(held(), rn, "timepoint_sign")).toMatchObject({
      code: "M10_SIGNER_LICENCE_NOT_ACTIVE",
      detail: { operation: "timepoint_sign", reason: "no_active_licence" },
    });
    expect(
      signerLicenceRefusal(
        held("np"),
        { authorDiscipline: "RN", rfaKind: "04_sfv" },
        "sfv_complete",
      ),
    ).toMatchObject({
      code: "M10_SIGNER_LICENCE_WRONG_DISCIPLINE",
      detail: { operation: "sfv_complete", reason: "wrong_discipline", heldKinds: ["np"] },
    });
  });
});
