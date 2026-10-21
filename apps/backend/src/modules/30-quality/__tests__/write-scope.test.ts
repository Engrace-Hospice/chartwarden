// GAP-091 follow-up — the M30 PHI WRITE path is patient-scoped at the SERVICE layer too ("both layers"):
// a second caller that skips the route predicate must still be refused (404) for a patient outside the
// actor's scope; a typed system actor keeps working; an org-wide role passes; any seam failure denies.
import { NotFoundError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { type M30WriteActor, m30SystemWriteActor } from "../routes/actor";
import type { QualityPatientScope } from "../routes/patient-scope";
import { assertWritePatientInScope } from "../routes/write-scope";
import { buildDrizzleM30WriteService } from "../routes/write-service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const IN_SCOPE = "22222222-2222-4222-8222-222222222221";
const OUT_OF_SCOPE = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";

const userActor = (roles: readonly string[]): M30WriteActor => ({
  organizationId: ORG,
  userId: "u1",
  roles,
  membershipId: MEMBERSHIP,
});
const caseloadScope: QualityPatientScope = { kind: "caseload", patientIds: [IN_SCOPE] };

describe("assertWritePatientInScope", () => {
  it("refuses a patient outside the caseload with NotFound (404, no existence leak)", async () => {
    await expect(
      assertWritePatientInScope(userActor(["rn"]), OUT_OF_SCOPE, async () => caseloadScope),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("allows a patient on the caseload", async () => {
    await expect(
      assertWritePatientInScope(userActor(["rn"]), IN_SCOPE, async () => caseloadScope),
    ).resolves.toBeUndefined();
  });

  it("allows a patient-less row (org-level) without consulting the resolver", async () => {
    const resolver = async (): Promise<QualityPatientScope> => {
      throw new Error("must not be called");
    };
    await expect(
      assertWritePatientInScope(userActor(["rn"]), undefined, resolver),
    ).resolves.toBeUndefined();
    await expect(
      assertWritePatientInScope(userActor(["rn"]), null, resolver),
    ).resolves.toBeUndefined();
  });

  it("passes an org-wide scope", async () => {
    await expect(
      assertWritePatientInScope(userActor(["medical_director"]), OUT_OF_SCOPE, async () => ({
        kind: "org",
      })),
    ).resolves.toBeUndefined();
  });

  it("fails CLOSED when the scope resolver throws (seam down / unbound)", async () => {
    await expect(
      assertWritePatientInScope(userActor(["rn"]), IN_SCOPE, async () => {
        throw new Error("seam down");
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lets a typed system actor through without consulting the resolver", async () => {
    const system = m30SystemWriteActor({
      organizationId: ORG,
      userId: MEMBERSHIP,
      membershipId: MEMBERSHIP,
    });
    const resolver = async (): Promise<QualityPatientScope> => {
      throw new Error("must not be called");
    };
    await expect(
      assertWritePatientInScope(system, OUT_OF_SCOPE, resolver),
    ).resolves.toBeUndefined();
  });

  it("never infers system from a role string or a look-alike field", async () => {
    const forged = {
      ...userActor(["system", "platform_owner", "service_account"]),
      actorKind: "system",
      system: true,
    } as unknown as M30WriteActor;
    await expect(
      assertWritePatientInScope(forged, OUT_OF_SCOPE, async () => caseloadScope),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not let a JSON-cloned system actor keep its system-ness", async () => {
    const system = m30SystemWriteActor({
      organizationId: ORG,
      userId: MEMBERSHIP,
      membershipId: MEMBERSHIP,
    });
    const cloned = JSON.parse(JSON.stringify(system)) as M30WriteActor;
    await expect(
      assertWritePatientInScope(cloned, OUT_OF_SCOPE, async () => caseloadScope),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── the Drizzle service enforces it itself (a caller that skipped the route predicate) ────────────────

class DbTouched extends Error {}
/** A db whose first use throws: proves a denied write never opens a transaction, an allowed one does. */
const touchingDb = {
  transaction: async () => {
    throw new DbTouched("transaction opened");
  },
};
const build = (scope: QualityPatientScope | "throw") =>
  buildDrizzleM30WriteService(touchingDb as never, {
    patientScope: async () => {
      if (scope === "throw") throw new Error("seam down");
      return scope;
    },
  });

const incidentArgs = (patientId?: string) => ({
  kind: "fall" as const,
  severity: "moderate" as const,
  patientId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  data: {},
});
const infectionArgs = (patientId: string) => ({
  patientId,
  pathogen: "mrsa",
  bodySite: "skin",
  observedAt: "2026-01-01T00:00:00.000Z",
});

describe("buildDrizzleM30WriteService — service-layer patient scope on create", () => {
  it("createIncident refuses an out-of-scope patient with NotFound before touching the db", async () => {
    await expect(
      build(caseloadScope).createIncident(userActor(["rn"]), incidentArgs(OUT_OF_SCOPE)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("recordInfectionEvent refuses an out-of-scope patient with NotFound before touching the db", async () => {
    await expect(
      build(caseloadScope).recordInfectionEvent(userActor(["rn"]), infectionArgs(OUT_OF_SCOPE)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("denies both when the caseload seam throws", async () => {
    await expect(
      build("throw").createIncident(userActor(["rn"]), incidentArgs(IN_SCOPE)),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      build("throw").recordInfectionEvent(userActor(["rn"]), infectionArgs(IN_SCOPE)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an in-scope patient, an org-wide scope, a patient-less incident and a system actor all reach the db", async () => {
    const rn = userActor(["rn"]);
    await expect(
      build(caseloadScope).createIncident(rn, incidentArgs(IN_SCOPE)),
    ).rejects.toBeInstanceOf(DbTouched);
    await expect(
      build({ kind: "org" }).createIncident(
        userActor(["medical_director"]),
        incidentArgs(OUT_OF_SCOPE),
      ),
    ).rejects.toBeInstanceOf(DbTouched);
    await expect(
      build(caseloadScope).createIncident(rn, incidentArgs(undefined)),
    ).rejects.toBeInstanceOf(DbTouched);
    const system = m30SystemWriteActor({
      organizationId: ORG,
      userId: MEMBERSHIP,
      membershipId: MEMBERSHIP,
    });
    await expect(
      build(caseloadScope).createIncident(system, incidentArgs(OUT_OF_SCOPE)),
    ).rejects.toBeInstanceOf(DbTouched);
    await expect(
      build(caseloadScope).recordInfectionEvent(system, infectionArgs(OUT_OF_SCOPE)),
    ).rejects.toBeInstanceOf(DbTouched);
  });
});
