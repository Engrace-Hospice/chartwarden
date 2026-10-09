// apps/backend/src/modules/05-patient/routes/service.ts — the PatientRouteService + an in-memory
// slice (M5-T09, §4.2). The routes compose over this; production injects the Drizzle-backed service
// (writes under withOrgContext so RLS scopes by app.org_id). The slice runs the REAL T06 matcher so
// the §7.1 admit-no-dup workflow is exercised end-to-end. Pure-ish: no clock except an injected
// `now()` so the §7.7 60-day SLA is deterministic in tests.
import {
  type MatchCandidate,
  type RawSubject,
  normalizeSubject,
  runMatch,
} from "../matching/index";

/** The admit payload (§4.2 capture contract — the demographics a create carries). */
export interface AdmitInput {
  readonly lastName: string;
  readonly firstName: string;
  readonly dob: string;
  readonly administrativeSex: string;
  readonly mbi?: string | null;
  readonly ssn?: string | null;
  readonly primaryAddress?: {
    line1: string;
    line2?: string | null;
    city: string;
    state?: string | null;
    postalCode: string;
  } | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly bypassMatchReview?: boolean;
  /** GAP-009: the required reason a permissioned actor skipped the duplicate pipeline (audited). */
  readonly bypassJustification?: string;
}

/** The admit outcome (§7.1). hard_block → 409; soft_review/created → 201. */
export type AdmitResult =
  | { readonly outcome: "created"; readonly patientId: string }
  | {
      readonly outcome: "soft_review";
      readonly patientId: string;
      readonly matchReviewIds: readonly string[];
    }
  | {
      readonly outcome: "hard_block";
      readonly existingPatientId: string;
      readonly matchedOn: string;
    };

/**
 * The admission-owned census KPIs (GAP-119), published by M6 and injected into M5 as a port — M5 never reads
 * M6's tables. Counts only.
 */
export interface AdmissionCensusSummaryView {
  readonly admissionsToday: number;
  readonly dischargesToday: number;
  readonly gipActive: number;
  readonly recertsDue: number;
  /** The org-local calendar date the "today" figures were computed for. */
  readonly asOfDate: string;
}

/** The org-explicit port M6's `admissionCensusSummaryForOrg` is bound to at the composition root. */
export type AdmissionCensusSummaryPort = (
  organizationId: string,
) => Promise<AdmissionCensusSummaryView>;

/**
 * Census KPI counts (§4.2) — `total` patients in the org + a per-status breakdown, plus the M6 admission
 * summary (`null` when M6's read is unavailable: the strip shows "—", never a made-up number).
 */
export interface CensusMetrics {
  readonly total: number;
  readonly byStatus: Record<string, number>;
  readonly admissions?: AdmissionCensusSummaryView | null;
}

/** A minimal patient view a read returns. */
export interface PatientView {
  readonly id: string;
  readonly organizationId: string;
  readonly mrn: string;
  readonly lastName: string;
  readonly firstName: string;
  readonly dob: string;
  readonly status: string;
}

/**
 * One row of the §3.3 / D5 append-only `patient_address` history. A change inserts a NEW row and
 * closes the prior with `effectiveTo`; `current` (effectiveTo IS NULL) is the live row. At most one
 * `current && isPrimary` row per patient (a partial unique index enforces it). Geocode lat/lng are
 * filled asynchronously by the M5-T10 geocode job, so they may be null on a freshly-added row.
 */
export interface AddressView {
  readonly id: string;
  readonly kind: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly state: string | null;
  readonly postalCode: string;
  readonly country: string;
  readonly county: string | null;
  readonly isPrimary: boolean;
  readonly current: boolean; // effectiveTo IS NULL
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly geocodeLat: string | null;
  readonly geocodeLng: string | null;
}

/**
 * One row of the §3.4 `patient_payer` coverage list (Coverage / Payers tab). `payerId` resolves an
 * M40 canonical Payer — the DISPLAY NAME is resolved on the client via the MDM seam/client (no
 * cross-module schema import here). `rank` 1 = primary; `current` (effectiveTo IS NULL) marks the
 * live coverage. `subscriberId` is the member id (MBI for medicare_ffs) — plaintext, like the
 * identifiers tab's mbi.
 */
export interface PatientPayerView {
  readonly id: string;
  readonly payerId: string;
  readonly rank: number;
  readonly coverageKind: string;
  readonly subscriberId: string;
  readonly groupNumber: string | null;
  readonly binPcn: string | null;
  readonly current: boolean; // effectiveTo IS NULL
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface AddPatientPayerInput {
  readonly payerId: string;
  readonly rank: number;
  readonly coverageKind: string;
  readonly subscriberId: string;
  readonly groupNumber?: string | null;
  readonly binPcn?: string | null;
  readonly effectiveFrom: string;
}

/**
 * One §3.5 `patient_assignment` row for the Care Team & Assignments tab. Links a clinician (an M2
 * `user`) to the patient in a care-team `role`, open while `unassignedAt IS NULL` (`current`). The
 * clinician's DISPLAY NAME is NOT resolved here — that crosses into M2, so the row carries only
 * `clinicianUserId` and the client resolves the name through the M2 roster (mirrors the §3.4 payer →
 * M40 client-edge resolution). At most one current `primary_rn` per patient (a partial unique index).
 */
export interface AssignmentView {
  readonly id: string;
  readonly clinicianUserId: string;
  readonly role: string;
  readonly assignedAt: string;
  readonly unassignedAt: string | null;
  readonly current: boolean; // unassignedAt IS NULL
}

export interface CreatePatientAssignmentInput {
  readonly clinicianMembershipId: string;
  readonly role: string;
  readonly assignedAt?: string;
}

/**
 * One §3.4 caregiver involvement (a `patient_caregiver` row joined to its `caregiver` person). Carries
 * the relationship, the primary-caregiver flag, and the legal-representative authority (DPOA / guardian
 * / NOK). `current` (involvementTo IS NULL) marks a live involvement; at most one current primary.
 */
export interface CaregiverView {
  readonly id: string; // patient_caregiver.id
  readonly caregiverId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly relationship: string;
  readonly isPrimary: boolean;
  readonly isLegalRepresentative: boolean;
  readonly lrAuthority: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly current: boolean; // involvementTo IS NULL
}

/** One §3.4 `emergency_contact` row (priority 1 = first to call). */
export interface EmergencyContactView {
  readonly id: string;
  readonly name: string;
  readonly relationship: string;
  readonly phone: string;
  readonly email: string | null;
  readonly priority: number;
}

/**
 * The Care Team & Assignments tab payload (§3.4/§3.5): the clinical assignment roster + the caregiver
 * involvements + the emergency contacts. All three are M5-owned reads scoped by RLS to app.org_id.
 */
export interface CareTeamView {
  readonly assignments: readonly AssignmentView[];
  readonly caregivers: readonly CaregiverView[];
  readonly emergencyContacts: readonly EmergencyContactView[];
}

/**
 * The §3.5 / D10 Privacy Flags tab payload. `flags` is the patient's active privacy RESTRICTIONS,
 * read from the denormalized `patient_privacy_flag_snapshot` (recomputed from M39 `m39.consent.*`).
 * A flag present = restricted (no active consent removes it). `sudRestricted` is `flags ∋ "sud"` (the
 * 42 CFR Part 2 category); `sudDisclosable` is the §7.6 read gate decided by the M5 privacy engine —
 * FAIL-CLOSED: a SUD-restricted patient is non-disclosable until a Part-2 consent lifts the flag.
 */
export interface PrivacyFlagsView {
  readonly flags: readonly string[];
  readonly capturedAt: string | null;
  readonly sudRestricted: boolean;
  readonly sudDisclosable: boolean;
}

/** The add-address capture contract (§7.4). `isPrimary` triggers atomic primary rotation. */
export interface AddAddressInput {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly state?: string;
  readonly postalCode: string;
  readonly kind?: string;
  readonly isPrimary?: boolean;
}

/** An amendment record view (§7.7). */
export interface AmendmentView {
  readonly id: string;
  readonly patientId: string;
  readonly status: "pending" | "accepted" | "denied" | "withdrawn";
  readonly slaDueAt: string; // ISO; received + 60 days
}

/**
 * One identifier row for the Demographics & Identifiers tab (§3.3, §2.2). NEVER carries ciphertext:
 * `ssn`/`state_id` are `sensitive` → `value` is null and only `last4` (the `xxx-xx-####` tail) is
 * returned. Full reveal is a separate, `phi.read_ssn`-gated read (M5 SSN decryption follow-up).
 */
export interface IdentifierView {
  readonly id: string;
  readonly kind: string;
  readonly value: string | null; // plaintext for mrn/mbi/prior_mrn/…; null for ssn/state_id
  readonly last4: string | null; // display tail for the sensitive kinds (masked)
  readonly sensitive: boolean; // ssn | state_id
  readonly issuer: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** A preferred/maiden/aka name (§3.3 `patient_name_alias`). */
export interface NameAliasView {
  readonly kind: string; // 'preferred' | 'maiden' | 'aka'
  readonly fullName: string | null;
  readonly firstName: string | null;
  readonly middleName: string | null;
  readonly lastName: string | null;
}

/**
 * The Demographics tab payload (§3.3): legal name parts + DOB + the USCDI SOGI/race/ethnicity/marital
 * codes (resolved to labels via M38 value-sets on the client) + preferred language. All non-encrypted.
 */
export interface DemographicsView {
  readonly id: string;
  readonly mrn: string;
  readonly legalFirstName: string;
  readonly legalMiddleName: string | null;
  readonly legalLastName: string;
  readonly legalNameSuffix: string | null;
  readonly dob: string;
  readonly status: string;
  readonly sexAssignedAtBirth: string;
  readonly genderIdentityCode: string | null;
  readonly sexualOrientationCode: string | null;
  readonly pronounsCode: string | null;
  readonly maritalStatusCode: string | null;
  readonly raceCodes: readonly string[];
  readonly ethnicityCodes: readonly string[];
  readonly preferredLanguageCode: string | null;
  readonly aliases: readonly NameAliasView[];
}

/** The route service surface (§4.2). */
/** A query for the §4.2 census/list. Org binding is server-side, never in the query. */
export interface PatientListQuery {
  readonly q?: string; // name or MRN substring
  readonly status?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PatientRouteService {
  admit(organizationId: string, input: AdmitInput, actorUserId: string): Promise<AdmitResult>;
  getPatient(organizationId: string, id: string): Promise<PatientView | null>;
  getDemographics(organizationId: string, id: string): Promise<DemographicsView | null>;
  getIdentifiers(organizationId: string, id: string): Promise<IdentifierView[] | null>;
  /**
   * The §4.2 census. `scope` is the §7.5 narrowing set (F-096):
   *
   *   - `null`  — no narrowing: the actor holds an org-wide scope role and reads the whole tenant.
   *   - `[...]` — narrow to exactly these patient ids. **An EMPTY array returns NO rows**, and that is
   *               the point: an actor with no caseload has no census, and the fail-open shape here is
   *               `if (ids.length > 0) applyFilter(ids)`, which turns "sees nothing" into "sees
   *               everything" for precisely the actor who should see least.
   *
   * A caller cannot forget it — the parameter is required, and `null` is a thing you have to decide to
   * pass. Defaulting it to "no narrowing" would have made every existing caller keep its current
   * behaviour, which is the behaviour being fixed.
   */
  list(
    organizationId: string,
    query: PatientListQuery,
    scope: readonly string[] | null,
  ): Promise<{ items: PatientView[]; nextCursor: string | null }>;
  censusMetrics(organizationId: string): Promise<CensusMetrics>;
  listAddresses(organizationId: string, patientId: string): Promise<AddressView[] | null>;
  listPayers(organizationId: string, patientId: string): Promise<PatientPayerView[] | null>;
  addPayer(
    organizationId: string,
    patientId: string,
    input: AddPatientPayerInput,
    actorUserId: string,
  ): Promise<PatientPayerView>;
  getCareTeam(organizationId: string, patientId: string): Promise<CareTeamView | null>;
  createAssignment(
    organizationId: string,
    patientId: string,
    input: CreatePatientAssignmentInput,
    actorUserId: string,
  ): Promise<AssignmentView>;
  endAssignment(
    organizationId: string,
    patientId: string,
    assignmentId: string,
    actorUserId: string,
  ): Promise<AssignmentView>;
  getPrivacyFlags(organizationId: string, patientId: string): Promise<PrivacyFlagsView | null>;
  addAddress(
    organizationId: string,
    patientId: string,
    address: AddAddressInput,
    actorUserId: string,
  ): Promise<{
    addressId: string;
    cascadeEmitted: "m5.patient.address_changed";
  }>;
  submitAmendment(
    organizationId: string,
    patientId: string,
    input: {
      scope: string;
      rationale: string;
      requestedChange?: { fieldPath: string; requestedValue: string | null };
    },
    actorUserId: string,
  ): Promise<AmendmentView>;
  decideAmendment(
    organizationId: string,
    amendmentId: string,
    decision: { accept: boolean; denialReason?: string },
    actorUserId: string,
  ): Promise<AmendmentView>;
}

const SIXTY_DAYS_MS = 60 * 24 * 3600 * 1000;

/** Seed for the in-memory service (existing patients the matcher runs against). */
export interface InMemoryPatientSeed {
  readonly patients?: readonly (PatientView & MatchCandidate)[];
  /** Injected clock for the §7.7 SLA (defaults to a fixed instant if omitted). */
  readonly now?: () => Date;
}

/** An in-memory {@link PatientRouteService} for the slice/tests. Runs the real T06 matcher. */
export function createInMemoryPatientRouteService(seed: InMemoryPatientSeed = {}): {
  service: PatientRouteService;
  events: string[];
} {
  const events: string[] = [];
  const patients = new Map<string, PatientView & Partial<MatchCandidate>>();
  const candidates: (PatientView & MatchCandidate)[] = [...(seed.patients ?? [])];
  for (const p of candidates) patients.set(p.id, p);
  const amendments = new Map<string, AmendmentView>();
  const addresses = new Map<string, AddressView[]>(); // patientId → append-only address history
  const payers = new Map<string, PatientPayerView[]>(); // patientId → §3.4 coverage rows
  const assignments = new Map<string, AssignmentView[]>();
  const now = seed.now ?? (() => new Date("2026-06-20T00:00:00Z"));
  let seq = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: in-memory monotonic id counter.
  const nextId = (p: string) => `${p}_${(seq += 1)}`;

  function toCandidate(raw: RawSubject): MatchCandidate[] {
    void raw;
    return candidates;
  }

  const service: PatientRouteService = {
    async admit(organizationId, input, _actorUserId) {
      const incoming = normalizeSubject(input);
      // §7.1: run the matcher against existing patients (unless an explicit, permissioned bypass).
      if (!input.bypassMatchReview) {
        const result = runMatch(incoming, toCandidate(input));
        if (result.outcome === "hard_block") {
          events.push("m5.patient.duplicate_block");
          return {
            outcome: "hard_block",
            existingPatientId: result.existingPatientId,
            matchedOn: String(result.matchedOn),
          };
        }
        const id = nextId("pat");
        const view: PatientView & MatchCandidate = {
          ...incoming, // MatchSubject: lastName/firstName/dob/mbi/ssn/primaryAddress/phoneLast7/email
          id,
          organizationId,
          mrn: `MRN-${id}`,
          status: "prospective",
        };
        patients.set(id, view);
        candidates.push(view);
        events.push("m5.patient.created");
        if (result.outcome === "soft_review") {
          const reviewIds = result.reviewCandidates.map((c) => nextId("rev"));
          return {
            outcome: "soft_review",
            patientId: id,
            matchReviewIds: reviewIds,
          };
        }
        return { outcome: "created", patientId: id };
      }
      // bypass path
      const id = nextId("pat");
      patients.set(id, {
        id,
        organizationId,
        mrn: `MRN-${id}`,
        lastName: incoming.lastName,
        firstName: incoming.firstName,
        dob: incoming.dob,
        status: "prospective",
      });
      events.push("m5.patient.created");
      return { outcome: "created", patientId: id };
    },

    async getPatient(organizationId, id) {
      const p = patients.get(id);
      return p && p.organizationId === organizationId
        ? {
            id: p.id,
            organizationId: p.organizationId,
            mrn: p.mrn,
            lastName: p.lastName,
            firstName: p.firstName,
            dob: p.dob,
            status: p.status,
          }
        : null;
    },

    async getDemographics(organizationId, id) {
      const p = patients.get(id);
      if (!p || p.organizationId !== organizationId) return null;
      return {
        id: p.id,
        mrn: p.mrn,
        legalFirstName: p.firstName,
        legalMiddleName: null,
        legalLastName: p.lastName,
        legalNameSuffix: null,
        dob: p.dob,
        status: p.status,
        sexAssignedAtBirth: "UNK",
        genderIdentityCode: null,
        sexualOrientationCode: null,
        pronounsCode: null,
        maritalStatusCode: null,
        raceCodes: [],
        ethnicityCodes: [],
        preferredLanguageCode: null,
        aliases: [],
      };
    },

    async getIdentifiers(organizationId, id) {
      const p = patients.get(id);
      if (!p || p.organizationId !== organizationId) return null;
      const today = "2026-06-20";
      const rows: IdentifierView[] = [
        {
          id: `${id}_mrn`,
          kind: "mrn",
          value: p.mrn,
          last4: null,
          sensitive: false,
          issuer: null,
          effectiveFrom: today,
          effectiveTo: null,
        },
      ];
      if (p.mbi)
        rows.push({
          id: `${id}_mbi`,
          kind: "mbi",
          value: p.mbi,
          last4: null,
          sensitive: false,
          issuer: null,
          effectiveFrom: today,
          effectiveTo: null,
        });
      // §2.2: ssn is ENVELOPE-ENCRYPTED — the read layer NEVER returns the value, only the masked tail.
      if (p.ssn)
        rows.push({
          id: `${id}_ssn`,
          kind: "ssn",
          value: null,
          last4: p.ssn.replace(/\D/g, "").slice(-4) || null,
          sensitive: true,
          issuer: null,
          effectiveFrom: today,
          effectiveTo: null,
        });
      return rows;
    },

    async list(organizationId, query, scope) {
      // §7.5: org-scoped (prod relies on RLS; the slice filters by organizationId) AND caseload-narrowed
      // when `scope` names a set. `scope === null` is the org-wide reader; an empty set matches nothing.
      const inScope = scope === null ? () => true : (id: string) => scope.includes(id);
      const rows: PatientView[] = [...patients.values()]
        .filter((p) => p.organizationId === organizationId && inScope(p.id))
        .map((p) => ({
          id: p.id,
          organizationId: p.organizationId,
          mrn: p.mrn,
          lastName: p.lastName,
          firstName: p.firstName,
          dob: p.dob,
          status: p.status,
        }));
      const q = query.q?.trim().toLowerCase();
      const filtered = rows.filter((p) => {
        if (query.status && p.status !== query.status) return false;
        if (
          q &&
          !(
            `${p.lastName} ${p.firstName}`.toLowerCase().includes(q) ||
            p.mrn.toLowerCase().includes(q)
          )
        )
          return false;
        return true;
      });
      filtered.sort((a, b) =>
        a.lastName === b.lastName
          ? a.firstName.localeCompare(b.firstName)
          : a.lastName.localeCompare(b.lastName),
      );
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
      const page = filtered.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        items: page,
        nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      };
    },

    async censusMetrics(organizationId) {
      // §7.5: org-scoped (prod relies on RLS; the slice filters by organizationId).
      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const p of patients.values()) {
        if (p.organizationId !== organizationId) continue;
        total += 1;
        byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      }
      return { total, byStatus, admissions: null };
    },

    async listAddresses(organizationId, patientId) {
      const p = patients.get(patientId);
      if (!p || p.organizationId !== organizationId) return null; // §7.5 no-leak
      // current rows first (effectiveTo null), primary first, then newest.
      return [...(addresses.get(patientId) ?? [])].sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          Number(b.isPrimary) - Number(a.isPrimary) ||
          b.effectiveFrom.localeCompare(a.effectiveFrom),
      );
    },

    async listPayers(organizationId, patientId) {
      const p = patients.get(patientId);
      if (!p || p.organizationId !== organizationId) return null; // §7.5 no-leak
      // The slice carries no coverage seed; production reads `patient_payer` under RLS. Primary first.
      return [...(payers.get(patientId) ?? [])].sort(
        (a, b) => Number(b.current) - Number(a.current) || a.rank - b.rank,
      );
    },

    async addPayer(organizationId, patientId, input, _actorUserId) {
      const patient = patients.get(patientId);

      if (!patient || patient.organizationId !== organizationId) {
        throw new Error(`patient ${patientId} not found`);
      }

      const history = payers.get(patientId) ?? [];

      /*
       * One active coverage per (patient, rank).
       *
       * Adding a new coverage at an occupied rank closes the previous
       * current row rather than mutating it.
       */
      for (let index = 0; index < history.length; index += 1) {
        const payer = history[index]!;

        if (payer.rank === input.rank && payer.current) {
          history[index] = {
            ...payer,
            current: false,
            effectiveTo: input.effectiveFrom,
          };
        }
      }

      const row: PatientPayerView = {
        id: nextId("payer"),
        payerId: input.payerId,
        rank: input.rank,
        coverageKind: input.coverageKind,
        subscriberId: input.subscriberId,
        groupNumber: input.groupNumber ?? null,
        binPcn: input.binPcn ?? null,
        current: true,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
      };

      history.push(row);
      payers.set(patientId, history);

      events.push("m5.patient.payer_changed");

      return row;
    },

    async getCareTeam(organizationId, patientId) {
      const p = patients.get(patientId);
      if (!p || p.organizationId !== organizationId) return null; // §7.5 no-leak
      // The slice carries no care-team seed; production reads the M5 tables under RLS.
      return { assignments: [], caregivers: [], emergencyContacts: [] };
    },
    async createAssignment(organizationId, patientId, input, _actorUserId) {
      if (!patients.has(patientId)) throw new Error("patient not found");
      const rows = assignments.get(patientId) ?? [];
      if (
        rows.some(
          (row) =>
            row.current &&
            row.clinicianUserId === input.clinicianMembershipId &&
            row.role === input.role,
        )
      )
        throw new Error("active assignment exists");
      const row: AssignmentView = {
        id: `assignment_${rows.length + 1}`,
        clinicianUserId: input.clinicianMembershipId,
        role: input.role,
        assignedAt: input.assignedAt ?? now().toISOString().slice(0, 10),
        unassignedAt: null,
        current: true,
      };
      assignments.set(patientId, [...rows, row]);
      events.push("m5.patient.assignment_created");
      return row;
    },
    async endAssignment(organizationId, patientId, assignmentId, _actorUserId) {
      const rows = assignments.get(patientId) ?? [];
      const found = rows.find((row) => row.id === assignmentId);
      if (!found || !found.current) throw new Error("assignment not found");
      const ended = { ...found, current: false, unassignedAt: now().toISOString().slice(0, 10) };
      assignments.set(
        patientId,
        rows.map((row) => (row.id === assignmentId ? ended : row)),
      );
      events.push("m5.patient.assignment_ended");
      return ended;
    },

    async getPrivacyFlags(organizationId, patientId) {
      const p = patients.get(patientId);
      if (!p || p.organizationId !== organizationId) return null; // §7.5 no-leak
      // The slice carries no snapshot seed; production reads `patient_privacy_flag_snapshot` under RLS.
      // No flags → unrestricted; SUD disclosable (§7.6 fail-closed only when the sud flag is present).
      return {
        flags: [],
        capturedAt: null,
        sudRestricted: false,
        sudDisclosable: true,
      };
    },

    async addAddress(_organizationId, patientId, address, _actorUserId) {
      // §7.4 / D5: append-only address + the address-change cascade event. An `isPrimary` add rotates
      // the current primary atomically — close the prior current primary (set effectiveTo), then append.
      const today = now().toISOString().slice(0, 10);
      const history = addresses.get(patientId) ?? [];
      if (address.isPrimary) {
        for (let i = 0; i < history.length; i += 1) {
          const a = history[i]!;
          if (a.isPrimary && a.current) history[i] = { ...a, current: false, effectiveTo: today };
        }
      }
      const id = nextId("addr");
      history.push({
        id,
        kind: address.kind ?? "home",
        line1: address.line1,
        line2: address.line2 ?? null,
        city: address.city,
        state: address.state ?? null,
        postalCode: address.postalCode,
        country: "US",
        county: null,
        isPrimary: address.isPrimary ?? false,
        current: true,
        effectiveFrom: today,
        effectiveTo: null,
        geocodeLat: null,
        geocodeLng: null,
      });
      addresses.set(patientId, history);
      events.push("m5.patient.address_changed");
      return { addressId: id, cascadeEmitted: "m5.patient.address_changed" };
    },

    async submitAmendment(_organizationId, patientId, _input, _actorUserId) {
      // §7.7: SLA due = received + 60 days.
      const id = nextId("amd");
      const slaDueAt = new Date(now().getTime() + SIXTY_DAYS_MS).toISOString();
      const view: AmendmentView = {
        id,
        patientId,
        status: "pending",
        slaDueAt,
      };
      amendments.set(id, view);
      events.push("m5.patient.amendment_request_received");
      return view;
    },

    async decideAmendment(_organizationId, amendmentId, decision, _actorUserId) {
      const a = amendments.get(amendmentId);
      if (!a) throw new Error(`amendment ${amendmentId} not found`);
      if (!decision.accept && !decision.denialReason) {
        throw new Error("denial requires a reason");
      }
      const next: AmendmentView = {
        ...a,
        status: decision.accept ? "accepted" : "denied",
      };
      amendments.set(amendmentId, next);
      events.push("m5.patient.amendment_decided");
      return next;
    },
  };

  return { service, events };
}
