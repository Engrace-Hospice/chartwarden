import { ForbiddenError } from "@wardenx/types";
// apps/backend/__tests__/encounter-workflow-acceptance.test.ts — M8-T12 the §7 workflow-acceptance
// suite. One scenario per §7 user story, exercised end-to-end over the in-memory EncounterRouteService
// (the same backend the routes compose over). Deterministic: no infra, injected clock. The route-auth
// handshake (§4.5/§4.6) + the §7.7 412 wire behaviour live in encounter-routes.test.ts; the pure SLA /
// late-entry / cosignature machines have their own suites — this asserts the WORKFLOW outcomes (state
// transitions, cosignature routing/escalation/release, late-entry tiers, addenda, concurrency).
import { describe, expect, it } from "vitest";
import {
  SLICE_DEFAULT_COSIGNER_MEMBERSHIP_ID,
  createInMemoryEncounterBackend,
} from "../src/modules/08-encounters/index";
import { ADDENDUM_SELECTIONS, requiredSectionSelections } from "./_hearthnote-fixtures";

const ORG = "org_a";
const ORG_B = "org_b";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const PAST = "2020-01-01"; // a non-future service date (createDraft rejects future dates)
// The in-memory backend's sign/cosignSign/signAddendum ignore the actor's step-up state (no real
// session infra in the slice — see routes/service.ts); the shape just needs to be well-formed.
const ACTOR = { membershipId: "actor_1", sessionId: "sess_1" };
/** A DIFFERENT membership — the RN cosigner (GAP-029: the author can never cosign their own note). */
const COSIGNER = { membershipId: "cosigner_1", sessionId: "sess_2" };

/**
 * Create a draft routine_visit for the given discipline and DOCUMENT it — one selection per required
 * template section, which is what the §2.6 Layer-3 gate (#121) asks of a note before it may finalize.
 * Pass `document: false` for a scenario whose subject is the gate itself.
 */
async function draft(
  discipline: "rn" | "lpn",
  document = true,
  seed: Parameters<typeof createInMemoryEncounterBackend>[0] = {},
) {
  const backend = createInMemoryEncounterBackend(seed);
  const created = await backend.service.createDraft(ORG, ACTOR.membershipId, {
    patientId: PATIENT,
    admissionId: ADMISSION,
    encounterType: "routine_visit",
    discipline,
    serviceDate: PAST,
  });
  if (document) {
    await backend.service.updateSelections(
      ORG,
      created.id,
      0,
      requiredSectionSelections("routine_visit", discipline),
    );
  }
  return { backend, svc: backend.service, id: created.id };
}

describe("M8-T12 §7 workflow acceptance", () => {
  it("§7.1 — RN routine visit happy path: draft → finalize → sign → signed (no cosignature)", async () => {
    const { svc, id } = await draft("rn");
    const fin = await svc.finalize(ORG, id, PAST);
    expect(fin.status).toBe("finalized");
    const signed = await svc.sign(ORG, id, ACTOR, { at: PAST });
    expect(signed.status).toBe("signed");
    expect(signed.cosignatureRequestId).toBeNull();
    expect((await svc.getEncounter(ORG, id)).status).toBe("signed");
  });

  it("§7.2 — LPN routine visit routes a cosignature: sign → cosign_pending → ack → RN signs → cosigned", async () => {
    const { backend, svc, id } = await draft("lpn");
    await svc.finalize(ORG, id, PAST);
    const signed = await svc.sign(ORG, id, ACTOR, { at: PAST });
    expect(signed.status).toBe("cosign_pending");
    expect((await svc.getCosignature(ORG, id)).status).toBe("routed");
    // §2.4 — routed to the patient's RN case manager, NOT to the LPN who just signed it (#124).
    expect(backend.inspect.cosignerOf(id)).toBe(SLICE_DEFAULT_COSIGNER_MEMBERSHIP_ID);
    expect(backend.inspect.cosignerOf(id)).not.toBe(ACTOR.membershipId);
    expect((await svc.cosignAcknowledge(ORG, id, COSIGNER, PAST)).status).toBe("acknowledged");
    const cos = await svc.cosignSign(ORG, id, COSIGNER, { isQualifiedRn: true, at: PAST });
    expect(cos.status).toBe("cosigned");
    expect(cos.cosignedAt).not.toBeNull();
  });

  it("GAP-029 — the author cannot acknowledge or cosign their own note (service-level guard)", async () => {
    const { svc, id } = await draft("lpn");
    await svc.finalize(ORG, id, PAST);
    await svc.sign(ORG, id, ACTOR, { at: PAST });
    await expect(svc.cosignAcknowledge(ORG, id, ACTOR, PAST)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      svc.cosignSign(ORG, id, ACTOR, { isQualifiedRn: true, at: PAST }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // …and the refusal left the cosignature workflow untouched.
    expect((await svc.getCosignature(ORG, id)).status).toBe("routed");
  });

  it("§7.3 — 48h hard cap locks cosignature until a supervisor releases, then an RN signs", async () => {
    // Seed a cosign-pending encounter already at the 48h hard cap (the SLA-clock escalation has its own suite).
    const backend = createInMemoryEncounterBackend({
      encounters: [
        {
          id: "e0000000-0000-4000-8000-0000000000aa",
          organizationId: ORG,
          patientId: PATIENT,
          discipline: "lpn",
          status: "cosign_pending",
          authoredByUserId: "lpn_1",
          cosignature: "hard_cap_reached",
        },
      ],
    });
    const id = "e0000000-0000-4000-8000-0000000000aa";
    // A cosigner cannot sign while hard-capped — the encounter is locked.
    await expect(
      backend.service.cosignSign(ORG, id, COSIGNER, { isQualifiedRn: true, at: PAST }),
    ).rejects.toThrow();
    const released = await backend.service.supervisorRelease(ORG, id, {
      isSupervisor: true,
      reason: "Primary cosigner on leave; covering supervisor reviewed and released per policy.",
      at: PAST,
    });
    expect(released.status).toBe("supervisor_released");
    const cos = await backend.service.cosignSign(ORG, id, COSIGNER, {
      isQualifiedRn: true,
      at: PAST,
    });
    expect(cos.status).toBe("cosigned");
  });

  it("§7.5 — significant late entry (3–14d) override stamps the significant_late_entry tier", async () => {
    const { svc, id } = await draft("rn");
    const r = await svc.lateEntryOverride(ORG, id, {
      actorMembershipId: ACTOR.membershipId,
      reason: "Supervisor reviewed the late entry context and approved completion in policy.",
    });
    expect(r.status).toBeDefined();
    expect((await svc.getEncounter(ORG, id)).lateEntryTier).toBe("significant_late_entry");
  });

  it("§7.6 — administrative (>14d) override stamps the administrative_override tier", async () => {
    const { svc, id } = await draft("rn");
    await svc.administrativeOverride(ORG, id, {
      actorMembershipId: ACTOR.membershipId,
      reason:
        "Director reviewed the administrative late entry context and approved signature after confirming the service date was valid.",
    });
    expect((await svc.getEncounter(ORG, id)).lateEntryTier).toBe("administrative_override");
  });

  it("§7.9 — an addendum can be created on a signed encounter and signed independently", async () => {
    const { svc, id } = await draft("rn");
    await svc.finalize(ORG, id, PAST);
    await svc.sign(ORG, id, ACTOR, { at: PAST });
    const add = await svc.createAddendum(ORG, id, {
      reason: "Correcting signed documentation.",
      authorMembershipId: ACTOR.membershipId,
    });
    expect(add.status).toBe("draft");
    await svc.updateAddendumSelections(ORG, id, add.id, ADDENDUM_SELECTIONS);
    await svc.finalizeAddendum(ORG, id, add.id);
    const sa = await svc.signAddendum(ORG, id, add.id, ACTOR, { at: PAST });
    expect(sa.status).toBe("signed");
    // The parent encounter status is unchanged by the addendum (append-only, §3.6).
    expect((await svc.getEncounter(ORG, id)).status).toBe("signed");
  });

  it("§7.9 — addenda cannot be created on draft encounters", async () => {
    const { svc, id } = await draft("rn");
    await expect(
      svc.createAddendum(ORG, id, {
        reason: "Trying to bypass normal draft editing.",
        authorMembershipId: ACTOR.membershipId,
      }),
    ).rejects.toThrow(/signed or cosigned/);
  });

  it("§2.6 — an undocumented encounter does not finalize: the Layer-3 gate names every missing section", async () => {
    const { svc, id } = await draft("rn", false);
    await expect(svc.finalize(ORG, id, PAST)).rejects.toMatchObject({
      code: "COMPLIANCE_GATE_FAILED",
      statusCode: 422,
    });
    // The remediation is per-section, so the UI can scroll to the first one (§7 "Finalize" flow).
    const err = await svc.finalize(ORG, id, PAST).catch((e: unknown) => e);
    const details = (err as { details?: Array<{ code: string; field?: string }> }).details ?? [];
    expect(details.map((d) => d.field).sort()).toEqual([
      "assessment",
      "chief_concern",
      "plan",
      "vitals_review",
    ]);
    expect(new Set(details.map((d) => d.code))).toEqual(new Set(["MISSING_SECTION"]));
    // ... and the row is still a draft: a failed preview is the transition not happening (§2.3).
    expect((await svc.getEncounter(ORG, id)).status).toBe("draft");
  });

  it("GAP-028 — sign() refuses a caller who is not the encounter's author (403)", async () => {
    const { svc, id } = await draft("rn");
    await svc.finalize(ORG, id, PAST);
    const other = { membershipId: "someone_else", sessionId: "sess_2" };
    await expect(svc.sign(ORG, id, other, { at: PAST })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect((await svc.getEncounter(ORG, id)).status).toBe("finalized");
  });

  it("§2.6 check 10 — an LPN note does not sign when the patient has no RN case manager", async () => {
    const { svc, id } = await draft("lpn", true, { primaryRnMembershipId: () => null });
    await svc.finalize(ORG, id, PAST);
    await expect(svc.sign(ORG, id, ACTOR, { at: PAST })).rejects.toMatchObject({
      code: "NO_ELIGIBLE_COSIGNER",
      statusCode: 422,
    });
    expect((await svc.getEncounter(ORG, id)).status).toBe("finalized");
  });

  it("§2.6 check 10 — a note may not route its cosignature to its own author", async () => {
    // The case manager resolves to the signing membership itself. `patient_assignment.role='primary_rn'`
    // makes this near-impossible in practice, which is exactly why it is asserted rather than assumed.
    const { svc, id } = await draft("lpn", true, {
      primaryRnMembershipId: () => ACTOR.membershipId,
    });
    await svc.finalize(ORG, id, PAST);
    await expect(svc.sign(ORG, id, ACTOR, { at: PAST })).rejects.toMatchObject({
      code: "NO_ELIGIBLE_COSIGNER",
    });
  });

  it("§2.6 check 10 — an RN note signs with no case manager at all (only LPN/CHHA route)", async () => {
    const { svc, id } = await draft("rn", true, { primaryRnMembershipId: () => null });
    await svc.finalize(ORG, id, PAST);
    expect((await svc.sign(ORG, id, ACTOR, { at: PAST })).status).toBe("signed");
  });

  it("§2.6 — an addendum with nothing in it does not sign", async () => {
    const { svc, id } = await draft("rn");
    await svc.finalize(ORG, id, PAST);
    await svc.sign(ORG, id, ACTOR, { at: PAST });
    const add = await svc.createAddendum(ORG, id, {
      reason: "Correcting signed documentation.",
      authorMembershipId: ACTOR.membershipId,
    });
    await expect(svc.finalizeAddendum(ORG, id, add.id)).rejects.toMatchObject({
      code: "COMPLIANCE_GATE_FAILED",
    });
  });

  it("§7.14 — concurrency: an edit against a stale version is rejected (optimistic concurrency)", async () => {
    // Undocumented on purpose: this scenario's subject is the If-Match ladder, so the draft starts at
    // version 0 rather than at the 1 that documenting it would leave behind.
    const { svc, id } = await draft("rn", false);
    const EMPTY = { sections: [] };
    await svc.updateSelections(ORG, id, 0, EMPTY); // version 0 → 1
    await expect(svc.updateSelections(ORG, id, 0, EMPTY)).rejects.toThrow(); // stale If-Match
    await expect(svc.updateSelections(ORG, id, 1, EMPTY)).resolves.toBeDefined(); // current succeeds
  });

  it("cross-tenant isolation: an encounter is invisible to another org (non-leaking 404)", async () => {
    const { svc, id } = await draft("rn");
    await expect(svc.getEncounter(ORG_B, id)).rejects.toThrow();
  });

  it("the cosignature queue + my-drafts surfaces are org-scoped over the backend", async () => {
    const { backend, svc, id } = await draft("lpn");
    await svc.finalize(ORG, id, PAST);
    await svc.sign(ORG, id, ACTOR, { at: PAST }); // → cosign_pending
    const queue = await svc.cosignatureQueue(ORG);
    expect(queue.encounters.some((e) => e.id === id)).toBe(true);
    expect((await svc.cosignatureQueue(ORG_B)).encounters).toEqual([]);
    void backend;
  });
});
