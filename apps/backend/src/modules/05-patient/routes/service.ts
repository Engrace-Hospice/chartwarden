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
  readonly primaryAddress?: { line1: string; city: string; postalCode: string } | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly bypassMatchReview?: boolean;
}

/** The admit outcome (§7.1). hard_block → 409; soft_review/created → 201. */
export type AdmitResult =
  | { readonly outcome: "created"; readonly patientId: string }
  | { readonly outcome: "soft_review"; readonly patientId: string; readonly matchReviewIds: readonly string[] }
  | { readonly outcome: "hard_block"; readonly existingPatientId: string; readonly matchedOn: string };

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
  list(
    organizationId: string,
    query: PatientListQuery,
  ): Promise<{ items: PatientView[]; nextCursor: string | null }>;
  listAddresses(organizationId: string, patientId: string): Promise<AddressView[] | null>;
  addAddress(
    organizationId: string,
    patientId: string,
    address: AddAddressInput,
    actorUserId: string,
  ): Promise<{ addressId: string; cascadeEmitted: "m5.patient.address_changed" }>;
  submitAmendment(
    organizationId: string,
    patientId: string,
    input: { scope: string; rationale: string },
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
  const now = seed.now ?? (() => new Date("2026-06-20T00:00:00Z"));
  let seq = 0;
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
          return { outcome: "hard_block", existingPatientId: result.existingPatientId, matchedOn: String(result.matchedOn) };
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
          return { outcome: "soft_review", patientId: id, matchReviewIds: reviewIds };
        }
        return { outcome: "created", patientId: id };
      }
      // bypass path
      const id = nextId("pat");
      patients.set(id, { id, organizationId, mrn: `MRN-${id}`, lastName: incoming.lastName, firstName: incoming.firstName, dob: incoming.dob, status: "prospective" });
      events.push("m5.patient.created");
      return { outcome: "created", patientId: id };
    },

    async getPatient(organizationId, id) {
      const p = patients.get(id);
      return p && p.organizationId === organizationId
        ? { id: p.id, organizationId: p.organizationId, mrn: p.mrn, lastName: p.lastName, firstName: p.firstName, dob: p.dob, status: p.status }
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
        { id: `${id}_mrn`, kind: "mrn", value: p.mrn, last4: null, sensitive: false, issuer: null, effectiveFrom: today, effectiveTo: null },
      ];
      if (p.mbi) rows.push({ id: `${id}_mbi`, kind: "mbi", value: p.mbi, last4: null, sensitive: false, issuer: null, effectiveFrom: today, effectiveTo: null });
      // §2.2: ssn is ENVELOPE-ENCRYPTED — the read layer NEVER returns the value, only the masked tail.
      if (p.ssn) rows.push({ id: `${id}_ssn`, kind: "ssn", value: null, last4: p.ssn.replace(/\D/g, "").slice(-4) || null, sensitive: true, issuer: null, effectiveFrom: today, effectiveTo: null });
      return rows;
    },

    async list(organizationId, query) {
      // §7.5: org-scoped (prod relies on RLS; the slice filters by organizationId).
      const rows: PatientView[] = [...patients.values()]
        .filter((p) => p.organizationId === organizationId)
        .map((p) => ({ id: p.id, organizationId: p.organizationId, mrn: p.mrn, lastName: p.lastName, firstName: p.firstName, dob: p.dob, status: p.status }));
      const q = query.q?.trim().toLowerCase();
      const filtered = rows.filter((p) => {
        if (query.status && p.status !== query.status) return false;
        if (q && !(`${p.lastName} ${p.firstName}`.toLowerCase().includes(q) || p.mrn.toLowerCase().includes(q))) return false;
        return true;
      });
      filtered.sort((a, b) => (a.lastName === b.lastName ? a.firstName.localeCompare(b.firstName) : a.lastName.localeCompare(b.lastName)));
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0;
      const page = filtered.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return { items: page, nextCursor: nextOffset < filtered.length ? String(nextOffset) : null };
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
      const view: AmendmentView = { id, patientId, status: "pending", slaDueAt };
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
      const next: AmendmentView = { ...a, status: decision.accept ? "accepted" : "denied" };
      amendments.set(amendmentId, next);
      events.push("m5.patient.amendment_decided");
      return next;
    },
  };

  return { service, events };
}
