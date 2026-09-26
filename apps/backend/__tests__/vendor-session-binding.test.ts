// apps/backend/__tests__/vendor-session-binding.test.ts — F-030 / #75, the last blocked key.
//
// THE DEFECT. M19's `external_triage_actor` decides whether an answering-service session may touch a
// triage call by comparing the SHIFT's `external_actor_id` against the SESSION's, read from
// `context.attributes.externalActorId`. Nothing wrote it: no route bound a vendor session, and M2 had no
// surface to bind through. So the comparison ran against `undefined` on every request and no
// vendor-scoped call could be recognised as one.
//
// It looked like the phase plan, which is why it survived. M19's spec ships the Hybrid/Centralized
// models feature-flagged-OFF in Phase 1 and promises a Phase-2 tenant is "a configuration flip +
// vendor-adapter package install, not a schema change" — so an absent vendor binding read as deferral
// rather than as a gap. It was a gap: the flip would have landed on a session layer that cannot express
// a vendor.
//
// WHAT THIS PINS, in the order the fact travels:
//   1. THE CLASS GATE — `sessionExternalActorId` reads the vendor only for a vendor CLASS. This is the
//      load-bearing one, and M19's own predicate header says why: folding the vendor arm into the owner
//      predicate "would let any staff session that happened to carry an `externalActorId` attribute
//      reach a vendor-scoped call". The same is true of reading the jsonb key directly.
//   2. THE SCOPE INVARIANT — a vendor class requires the vendor, in the app-layer mirror of the DB
//      CHECK (migration 0223).
//   3. THE BINDER — refuses a class it does not own, a missing vendor, and a cross-tenant session.
//   4. THE RESOLVER — the bound fact reaches `ResolvedActor` and the request context.
import {
  createInMemoryVendorSessionStore,
  createVendorSessionBinder,
  isSessionScopeValid,
  sessionExternalActorId,
  toSessionContextRecord,
} from "@wardenx/auth";
import { describe, expect, it } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const VENDOR = "33333333-3333-4333-8333-333333333333";

describe("F-030 — the vendor is read only for a vendor CLASS", () => {
  it("resolves the vendor on both M19 answering-service classes", () => {
    for (const sessionClass of ["external_triage_vendor", "external_triage_operator"] as const) {
      expect(sessionExternalActorId({ sessionClass, scope: { externalActorId: VENDOR } })).toBe(
        VENDOR,
      );
    }
  });

  it("reads NOTHING off a staff session that somehow carries the key", () => {
    // The attack the class gate closes. `scope` is jsonb, so nothing at the type level stops a staff
    // session from holding an `externalActorId`; what stops it MEANING anything is that the class
    // decides. Reading the key directly — the obvious implementation — would have widened the one
    // predicate whose entire job is to narrow.
    for (const sessionClass of [
      "staff",
      "auditor",
      "external_collaborator",
      "funeral_home",
      "patient_portal",
      "caregiver_portal",
      "bereaved_portal",
    ] as const) {
      expect(
        sessionExternalActorId({ sessionClass, scope: { externalActorId: VENDOR } }),
      ).toBeNull();
    }
  });

  it("resolves null for a vendor class with no vendor on it", () => {
    expect(
      sessionExternalActorId({ sessionClass: "external_triage_vendor", scope: {} }),
    ).toBeNull();
    expect(
      sessionExternalActorId({ sessionClass: "external_triage_vendor", scope: null }),
    ).toBeNull();
  });
});

describe("F-030 — the scope invariant (app mirror of migration 0223's session_scope_chk)", () => {
  it("a vendor session without its vendor is INVALID", () => {
    // 0220 gave the vendor classes no scope requirement, like `staff`, on the reasoning that a vendor
    // session is org-scoped rather than patient-scoped. True, and beside the point: it is VENDOR-scoped,
    // and a vendor session with no vendor is one `external_triage_actor` can never admit.
    for (const sessionClass of ["external_triage_vendor", "external_triage_operator"] as const) {
      expect(isSessionScopeValid({ sessionClass, scope: {} })).toBe(false);
      expect(isSessionScopeValid({ sessionClass, scope: null })).toBe(false);
      expect(isSessionScopeValid({ sessionClass, scope: { externalActorId: VENDOR } })).toBe(true);
    }
  });

  it("does not disturb the other classes' rules", () => {
    expect(isSessionScopeValid({ sessionClass: "staff", scope: null })).toBe(true);
    expect(isSessionScopeValid({ sessionClass: "external_collaborator", scope: null })).toBe(false);
    expect(
      isSessionScopeValid({ sessionClass: "caregiver_portal", scope: { portalAccountId: "a1" } }),
    ).toBe(true);
  });
});

describe("F-030 — the M2 VendorSessionBinder", () => {
  const seeded = () =>
    createInMemoryVendorSessionStore([
      { sessionId: "sess_1", organizationId: ORG, sessionClass: "staff", scope: null },
      { sessionId: "sess_other", organizationId: OTHER_ORG, sessionClass: "staff", scope: null },
    ]);

  it("stamps the class and the vendor onto the session", async () => {
    const { store, rows } = seeded();
    const result = await createVendorSessionBinder(store).bindVendorSession({
      scope: { orgId: ORG },
      sessionId: "sess_1",
      externalActorId: VENDOR,
      sessionClass: "external_triage_operator",
    });
    expect(result).toEqual({ sessionClass: "external_triage_operator" });
    expect(rows.get("sess_1")).toMatchObject({
      sessionClass: "external_triage_operator",
      scope: { externalActorId: VENDOR },
    });
  });

  it("the stamped session then resolves its vendor end to end", async () => {
    // The join the original defect lived in: the binder writes, and the resolver reads it back. Each
    // half worked in isolation for every F-030 key; the wire between them was what nothing ran.
    const { store, rows } = seeded();
    await createVendorSessionBinder(store).bindVendorSession({
      scope: { orgId: ORG },
      sessionId: "sess_1",
      externalActorId: VENDOR,
      sessionClass: "external_triage_vendor",
    });
    const row = rows.get("sess_1");
    const record = toSessionContextRecord(
      {
        userId: "u1",
        activeOrganizationId: ORG,
        lastStepUpAt: null,
        lastStepUpFactor: null,
        sessionClass: row?.sessionClass ?? "staff",
        scope: row?.scope ?? null,
        deviceAttestation: null,
      },
      "sess_1",
    );
    expect(record.externalActorId).toBe(VENDOR);
  });

  it("refuses a session in another tenant", async () => {
    // Org-scoped read, so absent and cross-tenant are indistinguishable to the caller on purpose.
    const { store, rows } = seeded();
    await expect(
      createVendorSessionBinder(store).bindVendorSession({
        scope: { orgId: ORG },
        sessionId: "sess_other",
        externalActorId: VENDOR,
        sessionClass: "external_triage_vendor",
      }),
    ).rejects.toThrow(/not found in this organization/);
    expect(rows.get("sess_other")?.sessionClass).toBe("staff");
  });

  it("refuses a bind with no vendor — the exact state the predicate can never admit", async () => {
    const { store } = seeded();
    await expect(
      createVendorSessionBinder(store).bindVendorSession({
        scope: { orgId: ORG },
        sessionId: "sess_1",
        externalActorId: "",
        sessionClass: "external_triage_vendor",
      }),
    ).rejects.toThrow(/external actor id is required/);
  });

  it("refuses a class it does not own, so a JS caller cannot write an arbitrary class", async () => {
    const { store, rows } = seeded();
    await expect(
      createVendorSessionBinder(store).bindVendorSession({
        scope: { orgId: ORG },
        sessionId: "sess_1",
        externalActorId: VENDOR,
        // Unreachable through the typed seam; this is the defense-in-depth branch. Writing e.g.
        // `patient_portal` here would produce a row that claims a class whose descriptor does not
        // require a vendor — so `sessionExternalActorId` would read null while the scope held one.
        sessionClass: "patient_portal" as never,
      }),
    ).rejects.toThrow(/is not a vendor session class/);
    expect(rows.get("sess_1")?.sessionClass).toBe("staff");
  });
});
