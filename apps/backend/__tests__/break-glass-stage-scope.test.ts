/**
 * CW-AC-03 — break-glass through the SHARED access path, one case table over every id-keyed clinical stage.
 *
 * Each stage's REAL scope predicate and its REAL break-glass subject resolver are registered (the owning module's own
 * `register*AbacPredicates`), over in-memory resolvers, behind the REAL `requireAbac` and the REAL
 * `registerBreakGlassContract`. Only the glass store is a fake, and it models what the durable store enforces per
 * request: the actor, the organization, the one named patient and the expiry. For every stage:
 *
 *   opens         a GET over the glassed patient's row is allowed, flags the request, and writes ONE critical
 *                 `m3.breakglass.access` row naming the patient (ids only);
 *   refuses       without a glass, after the glass expired, for another patient's row under the same glass, for another
 *                 tenant's actor, and for every method that is not a read.
 *
 * The same proof against Postgres, as the real `chartwarden_app` role, is `s11-adversarial-stages.live.test.ts`.
 */
import {
  BREAK_GLASS_ATTRIBUTE,
  type GuardRequest,
  type RequireAbacOptions,
  registerAbacRegistry,
  requireAbac,
  resetAuthorizationContract,
} from "@chartwarden/auth";
import type { HttpRequestContext } from "@chartwarden/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BreakGlassStore } from "../src/modules/03-authorization/authz-ports";
import { registerBreakGlassContract } from "../src/modules/03-authorization/contract";
import { registerAdmissionAbacPredicates } from "../src/modules/06-admission/abac-predicates";
import { registerEncounterAbacPredicates } from "../src/modules/08-encounters/abac-predicates";
import { registerHopeAbacPredicates } from "../src/modules/10-hope/abac-predicates";
import { registerEmarAbacPredicates } from "../src/modules/13-emar/abac-predicates";
import { registerIdgAbacPredicates } from "../src/modules/14-idg/abac-predicates";

const ORG = "org-a";
const OTHER_ORG = "org-b";
const ACTOR = "user-1";
const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const PATIENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER_PATIENT = "00000000-0000-4000-8000-0000000000a2";
const ROW = "00000000-0000-4000-8000-0000000000b1";
const OTHER_ROW = "00000000-0000-4000-8000-0000000000b2";
const GLASS_ID = "00000000-0000-4000-8000-0000000000c1";

/** The row each stage's in-memory resolver knows: `ROW` belongs to `PATIENT`, `OTHER_ROW` to `OTHER_PATIENT`. */
const PATIENT_OF: Readonly<Record<string, string>> = { [ROW]: PATIENT, [OTHER_ROW]: OTHER_PATIENT };
/** An in-memory resolver is org-scoped like the real loaders (RLS): another organization's actor resolves nothing. */
const patientOfRow = (id: string, organizationId: string = ORG): string | null =>
  organizationId === ORG ? (PATIENT_OF[id] ?? null) : null;

interface AuditRow {
  eventType: string;
  organizationId: string | null;
  severity: string;
  resourceId?: string;
}

/** A fake transactional DB: the break-glass audit hook writes its row through `withOrgContext`. */
function fakeDb() {
  const rows: AuditRow[] = [];
  const tx = {
    execute: async () => undefined,
    insert: () => ({ values: async (row: AuditRow) => void rows.push(row) }),
  };
  const db = { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { db, rows };
}

/**
 * What the durable store enforces on `findActiveGrant`: the grant's organization, its actor, its ONE patient (a null
 * request patient grants nothing) and its expiry.
 */
function glassStore(glass: { expiresAtMs: number } | null): BreakGlassStore {
  return {
    findActiveGrant: async (
      organizationId: string,
      actorUserId: string,
      patientId: string | null,
      nowMs: number,
    ) =>
      glass !== null &&
      organizationId === ORG &&
      actorUserId === ACTOR &&
      patientId === PATIENT &&
      nowMs < glass.expiresAtMs
        ? { eventId: GLASS_ID }
        : null,
  } as unknown as BreakGlassStore;
}

function makeRequest(
  params: unknown,
  method: string,
  organizationId = ORG,
  userId = ACTOR,
): GuardRequest {
  const context: HttpRequestContext = {
    correlationId: "corr-1",
    userId,
    organizationId,
    providerEntityIds: [],
    locationIds: [],
    roles: ["rn"],
    attributes: {},
    ip: "127.0.0.1",
    userAgent: "vitest",
    startTime: 0,
  };
  return { context, params, method };
}

/** A caseload that covers nobody, so the stage's own scope predicate always denies and the glass decides. */
const noCaseload = async () => false;

interface Stage {
  readonly name: string;
  /** Registers the stage's scope predicate AND its break-glass subject resolver, as the module's boot does. */
  readonly register: () => void;
  readonly action: string;
  readonly predicate: string;
  readonly options: RequireAbacOptions;
  /** The route params that address a row of the stage. */
  readonly paramsFor: (rowId: string) => Record<string, string>;
}

const READ_OPTIONS: RequireAbacOptions = { notFoundOnDeny: true };

const admissionFacts = (org: string, id: string) => {
  const patientId = patientOfRow(id, org);
  return patientId ? { patientId, providerEntityId: "pe-elsewhere", createdByUserId: null } : null;
};
const admissionRead: RequireAbacOptions = {
  ...READ_OPTIONS,
  getTarget: (request) => ({ ...(request.params as object), access: "read" }),
};

// ONE in-memory resolver per module, shared by every stage of it: the shared predicate registry keeps the FIRST
// registration of a name (a same-source re-boot is a no-op), so a second stage of the same module must close over the
// same resolver or its loaders would never be called.
const ADMISSION_RESOLVER = {
  loadAdmission: async (org: string, id: string) => admissionFacts(org, id),
  loadCtiScope: async (org: string, id: string) => admissionFacts(org, id),
} as never;
const ENCOUNTER_RESOLVER = {
  loadEncounter: async (org: string, id: string) => {
    const patientId = patientOfRow(id, org);
    return patientId ? { patientId, authoredByUserId: "m-author" } : null;
  },
  loadAddendumAuthor: async () => null,
} as never;
const EMAR_RESOLVER = {
  loadScopePatientId: async (org: string, _kind: string, id: string) => patientOfRow(id, org),
} as never;
const HOPE_RESOLVER = {
  loadAssessment: async (org: string, id: string) => {
    const patientId = patientOfRow(id, org);
    return patientId
      ? { patientId, originalSignedBy: null, rfaKind: "01", authorDiscipline: null }
      : null;
  },
} as never;

const registerAdmission = () =>
  registerAdmissionAbacPredicates({ resolver: ADMISSION_RESOLVER, isInCaseload: noCaseload });

const STAGES: readonly Stage[] = [
  {
    name: "admission",
    action: "admission.read",
    predicate: "admission.scope",
    options: admissionRead,
    paramsFor: (id) => ({ id }),
    register: registerAdmission,
  },
  {
    // The discharge-details read is guarded by the SAME `admission.scope` predicate, so the same resolver opens it.
    name: "discharge",
    action: "admission.read",
    predicate: "admission.scope",
    options: admissionRead,
    paramsFor: (id) => ({ id }),
    register: registerAdmission,
  },
  {
    // A child resource (a CTI) resolves through its OWNING admission, then to the patient.
    name: "admission child resource (CTI)",
    action: "cti.read",
    predicate: "admission.scope",
    options: {
      ...READ_OPTIONS,
      getTarget: (request) => ({
        ...(request.params as object),
        resourceKind: "cti",
        access: "read",
      }),
    },
    paramsFor: (id) => ({ id }),
    register: registerAdmission,
  },
  {
    name: "encounter",
    action: "encounter.read",
    predicate: "encounter.scope",
    options: READ_OPTIONS,
    paramsFor: (id) => ({ encounterId: id }),
    register: () =>
      registerEncounterAbacPredicates({ resolver: ENCOUNTER_RESOLVER, isInCaseload: noCaseload }),
  },
  {
    name: "eMAR",
    action: "administration.read",
    predicate: "emar.scope",
    options: {
      ...READ_OPTIONS,
      getTarget: (request) => ({ administrationId: (request.params as { id: string }).id }),
    },
    paramsFor: (id) => ({ id }),
    register: () =>
      registerEmarAbacPredicates({ resolver: EMAR_RESOLVER, isInCaseload: noCaseload }),
  },
  {
    name: "HOPE",
    action: "hope.timepoint.read",
    predicate: "hope.scope",
    options: READ_OPTIONS,
    paramsFor: (id) => ({ id }),
    register: () =>
      registerHopeAbacPredicates({ resolver: HOPE_RESOLVER, isInCaseload: noCaseload }),
  },
];

let audit: ReturnType<typeof fakeDb>;

beforeEach(() => {
  audit = fakeDb();
  registerAbacRegistry();
});

afterEach(() => {
  resetAuthorizationContract();
});

function openGlass(glass: { expiresAtMs: number } | null) {
  registerBreakGlassContract({
    store: glassStore(glass),
    db: audit.db as never,
    now: () => NOW,
  });
}

describe.each(STAGES)("break-glass at the $name stage (CW-AC-03)", (stage) => {
  const guard = () => requireAbac(stage.action, stage.predicate, stage.options);
  const live = { expiresAtMs: NOW + 60 * 60_000 };

  beforeEach(() => stage.register());

  it("opens a GET over the glassed patient's row, flags the request and writes ONE critical access row", async () => {
    openGlass(live);
    const request = makeRequest(stage.paramsFor(ROW), "GET");

    await expect(guard()(request)).resolves.toBeUndefined();

    expect(request.context.attributes[BREAK_GLASS_ATTRIBUTE]).toBe(GLASS_ID);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      eventType: "m3.breakglass.access",
      organizationId: ORG,
      severity: "critical",
      resourceId: PATIENT,
    });
  });

  it("refuses without a glass, and writes no access row", async () => {
    openGlass(null);
    await expect(guard()(makeRequest(stage.paramsFor(ROW), "GET"))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(audit.rows).toHaveLength(0);
  });

  it("refuses once the glass has expired", async () => {
    openGlass({ expiresAtMs: NOW - 1 });
    await expect(guard()(makeRequest(stage.paramsFor(ROW), "GET"))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(audit.rows).toHaveLength(0);
  });

  it("refuses another patient's row under the same glass (a grant covers ONE patient)", async () => {
    openGlass(live);
    await expect(guard()(makeRequest(stage.paramsFor(OTHER_ROW), "GET"))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(audit.rows).toHaveLength(0);
  });

  it("refuses a row that does not exist or belongs to another tenant (no patient resolves)", async () => {
    openGlass(live);
    const unknown = "00000000-0000-4000-8000-0000000000ff";
    await expect(guard()(makeRequest(stage.paramsFor(unknown), "GET"))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(audit.rows).toHaveLength(0);
  });

  it("refuses a colleague under the invoker's glass (a grant is the invoking actor's alone)", async () => {
    openGlass(live);
    await expect(
      guard()(makeRequest(stage.paramsFor(ROW), "GET", ORG, "user-2")),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(audit.rows).toHaveLength(0);
  });

  it("refuses another tenant's actor even with the same ids", async () => {
    openGlass(live);
    await expect(
      guard()(makeRequest(stage.paramsFor(ROW), "GET", OTHER_ORG)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(audit.rows).toHaveLength(0);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "never opens a %s: an emergency grant is read-only",
    async (method) => {
      openGlass(live);
      await expect(guard()(makeRequest(stage.paramsFor(ROW), method))).rejects.toMatchObject({
        statusCode: 404,
      });
      expect(audit.rows).toHaveLength(0);
    },
  );
});

describe("targets no single patient's glass may open (CW-AC-03)", () => {
  const live = { expiresAtMs: NOW + 60 * 60_000 };

  it("HOPE: a provider-entity scoped read belongs to no patient and stays refused", async () => {
    registerHopeAbacPredicates({ resolver: HOPE_RESOLVER, isInCaseload: noCaseload });
    openGlass(live);
    await expect(
      requireAbac("hope.submission.read", "hope.scope", { notFoundOnDeny: true })(
        makeRequest({ providerEntityId: "pe-9" }, "GET"),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(audit.rows).toHaveLength(0);
  });

  it("eMAR: a target naming two patients is not covered by a glass over one of them", async () => {
    registerEmarAbacPredicates({ resolver: EMAR_RESOLVER, isInCaseload: noCaseload });
    openGlass(live);
    await expect(
      requireAbac("administration.read", "emar.scope", {
        notFoundOnDeny: true,
        getTarget: () => ({ patientId: PATIENT, administrationId: OTHER_ROW }),
      })(makeRequest({}, "GET")),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(audit.rows).toHaveLength(0);
  });

  it("encounter: a target naming a patient AND another patient's encounter is not covered by a glass over the first", async () => {
    registerEncounterAbacPredicates({ resolver: ENCOUNTER_RESOLVER, isInCaseload: noCaseload });
    openGlass(live);
    await expect(
      requireAbac("encounter.read", "encounter.scope", {
        notFoundOnDeny: true,
        getTarget: () => ({ patientId: PATIENT, encounterId: OTHER_ROW }),
      })(makeRequest({}, "GET")),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(audit.rows).toHaveLength(0);
  });

  it("HOPE: a target naming a patient AND another patient's assessment is not covered by a glass over the first", async () => {
    registerHopeAbacPredicates({ resolver: HOPE_RESOLVER, isInCaseload: noCaseload });
    openGlass(live);
    await expect(
      requireAbac("hope.timepoint.read", "hope.scope", {
        notFoundOnDeny: true,
        getTarget: () => ({ patientId: PATIENT, assessmentId: OTHER_ROW }),
      })(makeRequest({}, "GET")),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(audit.rows).toHaveLength(0);
  });

  it("IDG: a meeting-scoped guard stays shut under a glass even when the route's params also name the glassed patient", async () => {
    registerIdgAbacPredicates({
      resolver: {
        loadMeetingScope: async () => ({ organizationId: ORG, locationId: "loc-elsewhere" }),
      } as never,
    });
    openGlass(live);
    await expect(
      requireAbac(
        "idg.read",
        "idg_meeting_scope",
      )(makeRequest({ meetingId: ROW, patientId: PATIENT }, "GET")),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(audit.rows).toHaveLength(0);
  });
});
