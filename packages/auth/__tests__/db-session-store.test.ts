// packages/auth/__tests__/db-session-store.test.ts — AUTH-T05b (ADR-0033).
// Pure mapping logic of the DB-backed SessionContextStore (the Drizzle query is verified in the
// AUTH-T06 live-PG lane). membershipId/roles are empty UNLESS an ActorEnrichment is supplied (the
// M3-owned reader path); both branches are covered here.
import { describe, expect, it } from "vitest";
import { toSessionContextRecord } from "../src/identity/db-session-store";

describe("toSessionContextRecord (AUTH-T05b)", () => {
  it("maps a session row to a context record (roles/membership deferred to M3)", () => {
    const at = new Date("2026-01-02T03:04:05Z");
    expect(
      toSessionContextRecord(
        {
          userId: "u1",
          activeOrganizationId: "org1",
          lastStepUpAt: at,
          lastStepUpFactor: "totp",
          sessionClass: "staff",
          scope: null,
          deviceAttestation: null,
        },
        "s1",
      ),
    ).toEqual({
      sessionId: "s1",
      userId: "u1",
      membershipId: null,
      organizationId: "org1",
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: at,
      lastStepUpFactor: "totp",
      // F-030 — the class and the portal scope now ride the record. Nothing carried them off the row
      // before, so M16/M19/M31's predicates read an absent class, defaulted it to `staff`, and denied.
      sessionClass: "staff",
      portalAccountId: null,
      // SecHardening §12.4 — a session with no joined `device_attestation` row resolves to null, which
      // is what `device_attestation_valid` must read as deny. Every browser session is this case.
      deviceAttestation: null,
      sessionPatientId: null,
      // F-030 — the vendor a session acts for, null on every class but M19's two.
      externalActorId: null,
      // GAP-093(c) — the auditor's engagement, null on every class but `auditor`.
      engagementId: null,
      auditorStage: null,
    });
  });

  it("carries a portal session's class + account, and its patient only once bound", () => {
    const unbound = toSessionContextRecord(
      {
        userId: "u3",
        activeOrganizationId: "org1",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "caregiver_portal",
        scope: { portalAccountId: "acct-1" },
        deviceAttestation: null,
      },
      "s3",
    );
    expect(unbound.sessionClass).toBe("caregiver_portal");
    expect(unbound.portalAccountId).toBe("acct-1");
    expect(unbound.sessionPatientId).toBeNull(); // before select-patient (M31 §2.3 / D2)

    const bound = toSessionContextRecord(
      {
        userId: "u3",
        activeOrganizationId: "org1",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "caregiver_portal",
        scope: { portalAccountId: "acct-1", patientId: "pt-9" },
        deviceAttestation: null,
      },
      "s3",
    );
    expect(bound.sessionPatientId).toBe("pt-9");
  });

  it("survives a malformed or absent `scope` rather than throwing on it", () => {
    // `scope` is jsonb and nullable; a row written before the portal classes existed has none, and a
    // hand-edited row could have anything. Neither may take down the authenticate hook.
    for (const scope of [null, undefined, "not-an-object", 42, { portalAccountId: 7 }, {}]) {
      const rec = toSessionContextRecord(
        {
          userId: "u4",
          activeOrganizationId: "org1",
          lastStepUpAt: null,
          lastStepUpFactor: null,
          sessionClass: "staff",
          scope,
          deviceAttestation: null,
        },
        "s4",
      );
      expect(rec.portalAccountId).toBeNull();
      expect(rec.sessionPatientId).toBeNull();
    }
  });

  it("defaults an absent class to `staff` — the column is NOT NULL DEFAULT 'staff'", () => {
    const rec = toSessionContextRecord(
      {
        userId: "u5",
        activeOrganizationId: "org1",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: null,
        scope: null,
        deviceAttestation: null,
      },
      "s5",
    );
    expect(rec.sessionClass).toBe("staff");
  });

  // ── F-030 · the pinned patient is decided by the CLASS, not by the presence of a jsonb key ──────
  //
  // `sessionPatientId` replaced three names for this one fact — M31/M19's `portalPatientId`, M19's
  // `patientId` fallback beside it, and M7's `scopePatientIds` array — none of which anything wrote.
  // M7's readers are `external_collaborator` sessions, which is why the key is not named for a class:
  // a collaborator is pinned from the moment it is minted, with no select-patient step at all.

  it("pins a collaborator/funeral session from mint — no select-patient step exists for them", () => {
    for (const sessionClass of ["external_collaborator", "funeral_home"]) {
      const rec = toSessionContextRecord(
        {
          userId: "u6",
          activeOrganizationId: "org1",
          lastStepUpAt: null,
          lastStepUpFactor: null,
          sessionClass,
          scope: { patientId: "pt-7" },
          deviceAttestation: null,
        },
        "s6",
      );
      expect(rec.sessionPatientId).toBe("pt-7");
      expect(rec.portalAccountId).toBeNull(); // they carry no portal account
    }
  });

  it("a STAFF session carrying a stray `scope.patientId` is pinned to nothing", () => {
    // The regression this guards: reading the column straight off the jsonb (what the store did
    // before) would hand M7's `caseload_or_scope` a session-scope grant for any org-scoped session
    // whose `scope` happened to carry a patient id — a widening, in the one predicate whose whole job
    // is to narrow. `sessionPinnedPatientId` asks the CLASS, so staff/auditor/vendor pin nothing.
    for (const sessionClass of ["staff", "auditor", "external_triage_vendor"]) {
      const rec = toSessionContextRecord(
        {
          userId: "u7",
          activeOrganizationId: "org1",
          lastStepUpAt: null,
          lastStepUpFactor: null,
          sessionClass,
          scope: { patientId: "pt-8" },
          deviceAttestation: null,
        },
        "s7",
      );
      expect(rec.sessionPatientId).toBeNull();
    }
  });

  it("an UNRECOGNISED class pins nothing rather than throwing", () => {
    // A row written by a migration newer than this build (0219 added five labels; the next one may add
    // more) has a class no descriptor knows. Indexing the descriptor map on it yields `undefined`, and
    // reading `.requiresPortalAccount` off that would throw inside the authenticate hook — a 500 on
    // every request from that session. Unknown ⇒ pinned to nothing, which is the closed end.
    const rec = toSessionContextRecord(
      {
        userId: "u8",
        activeOrganizationId: "org1",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "a_class_from_the_future",
        scope: { patientId: "pt-9" },
        deviceAttestation: null,
      },
      "s8",
    );
    expect(rec.sessionPatientId).toBeNull();
    expect(rec.sessionClass).toBe("a_class_from_the_future");
  });

  it("maps a pre-org session to organizationId '' (resolver org-guard yields null)", () => {
    const rec = toSessionContextRecord(
      {
        userId: "u2",
        activeOrganizationId: null,
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "staff",
        scope: null,
        deviceAttestation: null,
      },
      "s2",
    );
    expect(rec.organizationId).toBe("");
    expect(rec.lastStepUpAt).toBeNull();
    expect(rec.lastStepUpFactor).toBeNull();
  });

  it("merges M3 actor enrichment (membershipId + roles + PE/location scope) when supplied", () => {
    const rec = toSessionContextRecord(
      {
        userId: "u3",
        activeOrganizationId: "org3",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "staff",
        scope: null,
        deviceAttestation: null,
      },
      "s3",
      {
        membershipId: "m3",
        roles: ["nurse", "on_call"],
        providerEntityIds: ["pe-1"],
        locationIds: ["loc-1", "loc-2"],
      },
    );
    expect(rec.membershipId).toBe("m3");
    expect(rec.roles).toEqual(["nurse", "on_call"]);
    expect(rec.providerEntityIds).toEqual(["pe-1"]);
    expect(rec.locationIds).toEqual(["loc-1", "loc-2"]);
  });

  it("keeps empty membership/roles/scope when enrichment is null (no active membership in scope)", () => {
    const rec = toSessionContextRecord(
      {
        userId: "u4",
        activeOrganizationId: "org4",
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: "staff",
        scope: null,
        deviceAttestation: null,
      },
      "s4",
      null,
    );
    expect(rec.membershipId).toBeNull();
    expect(rec.roles).toEqual([]);
    expect(rec.providerEntityIds).toEqual([]);
    expect(rec.locationIds).toEqual([]);
  });
});
