// apps/backend/src/modules/29-external-interfaces/inbound — the §4.6 D6 deterministic patient-match cascade
// (M29-T04 / T-29.05). PURE over an injected `PatientReader` seam (M5, `@wardenx/types`) — no DB, no clock
// except an injected per-call timeout. The single most-consequential algorithm in M29: every inbound ADT
// (and, in T05, every inbound lab) runs it, and the discriminated {@link MatchOutcome} routes the message to
// propose-then-review (D5) — NEVER a direct M5/M6 mutation.
//
// The five levels are tried in ORDER; the first definitive result returns (sequential by design, T-29.05 §4.3:
// L1 is the common positive case, and higher levels depend on lower-level negative signal). Every match
// resolves M5 merge-redirects transparently (≤ 3 hops; a dangling/over-long chain fails closed to no-match).
import type { PatientIdentity, PatientReader } from "@wardenx/types";
import type { Hl7InboundMatchLevel } from "@wardenx/types";

/** The confident (L1-L3), candidate (L4-L5), and ambiguous match levels, typed off the leaf enum. */
type ConfidentLevel = Extract<
  Hl7InboundMatchLevel,
  "L1_MRN_EXACT" | "L2_EXTERNAL_MRN_EXACT" | "L3_SSN_DOB"
>;
type CandidateLevel = Extract<
  Hl7InboundMatchLevel,
  "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE" | "L5_LOOSE_NAME_DOB_CANDIDATE"
>;
type AmbiguousLevel = Extract<
  Hl7InboundMatchLevel,
  "L3_SSN_DOB" | "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE"
>;

/** The discriminated cascade outcome (§4.6). `confidence` mirrors the D6 fixed weights (L4 0.92, L5 0.78). */
export type MatchOutcome =
  | {
      readonly kind: "confident_match";
      readonly patientId: string;
      readonly level: ConfidentLevel;
      readonly mergeRedirectHops: number;
    }
  | {
      readonly kind: "candidate_match";
      readonly patientId: string;
      readonly level: CandidateLevel;
      readonly confidence: number;
      readonly mergeRedirectHops: number;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidateIds: readonly string[];
      readonly level: AmbiguousLevel;
    }
  | { readonly kind: "no_match" };

/** The parsed PID the cascade matches on (projected by {@link projectAdt}). */
export interface CascadePid {
  readonly identifiers: readonly { readonly value: string; readonly assigningAuthority: string }[];
  readonly lastName: string;
  readonly firstName: string;
  /** ISO `yyyy-mm-dd`; empty string skips the DOB-dependent levels (L3/L4/L5). */
  readonly dateOfBirth: string;
  readonly administrativeSex: string;
  readonly ssnLast4?: string;
}

export interface CascadeInput {
  readonly organizationId: string;
  /** `organization.settings.hl7_internal_mrn_authority` — absent ⇒ L1 is skipped (no internal MRN candidate). */
  readonly internalMrnAuthority?: string;
  readonly pid: CascadePid;
}

/** A structured trace sink (optional) — mirrors the T03 `log(level, event, fields)` port; never PHI. */
export type CascadeLog = (event: string, fields: Record<string, unknown>) => void;

export interface CascadeDeps {
  readonly patientReader: PatientReader;
  /** Fail-fast ceiling per seam call (T-29.05 §3.2 SLO: p95 < 200ms; default 1500ms). */
  readonly perCallTimeoutMs?: number;
  readonly log?: CascadeLog;
}

const DEFAULT_PER_CALL_TIMEOUT_MS = 1500;
const MAX_MERGE_HOPS = 3;
/** D6 fixed confidence weights for the two candidate levels. */
export const L4_CONFIDENCE = 0.92;
export const L5_CONFIDENCE = 0.78;

/** Run the deterministic five-level cascade. Throws `cascade_seam_timeout_<level>` if a seam call hangs. */
export async function matchPatient(input: CascadeInput, deps: CascadeDeps): Promise<MatchOutcome> {
  const timeoutMs = deps.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;
  const log = deps.log ?? (() => {});
  const { pid } = input;

  // ─── Level 1: internal MRN exact ────────────────────────────────────────
  if (input.internalMrnAuthority) {
    const internalId = pid.identifiers.find(
      (id) => id.assigningAuthority === input.internalMrnAuthority,
    );
    if (internalId?.value) {
      const hit = await withTimeout(
        deps.patientReader.findByMrn({
          organizationId: input.organizationId,
          mrn: internalId.value,
        }),
        timeoutMs,
        "L1_MRN_EXACT",
      );
      const resolved = hit ? await resolveMerge(hit, input.organizationId, deps) : null;
      if (resolved?.patient) {
        log("hl7.cascade.confident_match", {
          level: "L1_MRN_EXACT",
          patientId: resolved.patient.id,
          hops: resolved.hops,
        });
        return {
          kind: "confident_match",
          patientId: resolved.patient.id,
          level: "L1_MRN_EXACT",
          mergeRedirectHops: resolved.hops,
        };
      }
    }
  }

  // ─── Level 2: external-system MRN exact ─────────────────────────────────
  for (const id of pid.identifiers) {
    if (input.internalMrnAuthority && id.assigningAuthority === input.internalMrnAuthority)
      continue;
    if (!id.value || !id.assigningAuthority) continue;
    const hit = await withTimeout(
      deps.patientReader.findByExternalMrn({
        organizationId: input.organizationId,
        assigningAuthority: id.assigningAuthority,
        value: id.value,
      }),
      timeoutMs,
      "L2_EXTERNAL_MRN_EXACT",
    );
    const resolved = hit ? await resolveMerge(hit, input.organizationId, deps) : null;
    if (resolved?.patient) {
      log("hl7.cascade.confident_match", {
        level: "L2_EXTERNAL_MRN_EXACT",
        patientId: resolved.patient.id,
        hops: resolved.hops,
      });
      return {
        kind: "confident_match",
        patientId: resolved.patient.id,
        level: "L2_EXTERNAL_MRN_EXACT",
        mergeRedirectHops: resolved.hops,
      };
    }
  }

  // ─── Level 3: SSN-last4 + DOB ───────────────────────────────────────────
  if (pid.ssnLast4 && pid.dateOfBirth) {
    if (!isValidSsnLast4(pid.ssnLast4)) {
      log("hl7.cascade.ssn_last4_invalid_skipped", { ssnLast4Length: pid.ssnLast4.length });
    } else {
      const hits = await withTimeout(
        deps.patientReader.findBySsnLast4AndDob({
          organizationId: input.organizationId,
          ssnLast4: pid.ssnLast4,
          dateOfBirth: pid.dateOfBirth,
        }),
        timeoutMs,
        "L3_SSN_DOB",
      );
      if (hits.length === 1) {
        const resolved = await resolveMerge(hits[0]!, input.organizationId, deps);
        if (resolved.patient) {
          log("hl7.cascade.confident_match", {
            level: "L3_SSN_DOB",
            patientId: resolved.patient.id,
            hops: resolved.hops,
          });
          return {
            kind: "confident_match",
            patientId: resolved.patient.id,
            level: "L3_SSN_DOB",
            mergeRedirectHops: resolved.hops,
          };
        }
      } else if (hits.length > 1) {
        log("hl7.cascade.ambiguous_fallthrough", {
          level: "L3_SSN_DOB",
          candidateCount: hits.length,
        });
        return { kind: "ambiguous", candidateIds: hits.map((h) => h.id), level: "L3_SSN_DOB" };
      }
    }
  }

  // ─── Level 4: exact name + DOB + sex ────────────────────────────────────
  if (pid.dateOfBirth && pid.lastName && pid.firstName) {
    const hits = await withTimeout(
      deps.patientReader.findByNameDobSex({
        organizationId: input.organizationId,
        lastName: pid.lastName,
        firstName: pid.firstName,
        dateOfBirth: pid.dateOfBirth,
        administrativeSex: pid.administrativeSex,
      }),
      timeoutMs,
      "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
    );
    if (hits.length === 1) {
      const resolved = await resolveMerge(hits[0]!, input.organizationId, deps);
      if (resolved.patient) {
        log("hl7.cascade.candidate_match", {
          level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
          patientId: resolved.patient.id,
          hops: resolved.hops,
        });
        return {
          kind: "candidate_match",
          patientId: resolved.patient.id,
          level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
          confidence: L4_CONFIDENCE,
          mergeRedirectHops: resolved.hops,
        };
      }
    } else if (hits.length > 1) {
      log("hl7.cascade.ambiguous_l4", { candidateCount: hits.length });
      return {
        kind: "ambiguous",
        candidateIds: hits.map((h) => h.id),
        level: "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
      };
    }
  }

  // ─── Level 5: loose name + DOB ──────────────────────────────────────────
  if (pid.dateOfBirth && pid.lastName) {
    const hits = await withTimeout(
      deps.patientReader.findByLooseName({
        organizationId: input.organizationId,
        lastName: pid.lastName,
        firstNameInitial: pid.firstName?.[0],
        dateOfBirth: pid.dateOfBirth,
      }),
      timeoutMs,
      "L5_LOOSE_NAME_DOB_CANDIDATE",
    );
    if (hits.length === 1) {
      const resolved = await resolveMerge(hits[0]!, input.organizationId, deps);
      if (resolved.patient) {
        log("hl7.cascade.candidate_match", {
          level: "L5_LOOSE_NAME_DOB_CANDIDATE",
          patientId: resolved.patient.id,
          hops: resolved.hops,
        });
        return {
          kind: "candidate_match",
          patientId: resolved.patient.id,
          level: "L5_LOOSE_NAME_DOB_CANDIDATE",
          confidence: L5_CONFIDENCE,
          mergeRedirectHops: resolved.hops,
        };
      }
    }
    // L5 with >1 hits is too loose to even propose — falls through to no_match.
  }

  log("hl7.cascade.no_match", {});
  return { kind: "no_match" };
}

interface MergeResolveResult {
  readonly patient: PatientIdentity | null;
  readonly hops: number;
}

/** Follow `mergedIntoId` to the survivor (≤ {@link MAX_MERGE_HOPS}); dangling/over-long ⇒ null (fail closed). */
async function resolveMerge(
  start: PatientIdentity,
  organizationId: string,
  deps: CascadeDeps,
): Promise<MergeResolveResult> {
  const log = deps.log ?? (() => {});
  let current: PatientIdentity | null = start;
  let hops = 0;
  while (current?.mergedIntoId && hops < MAX_MERGE_HOPS) {
    hops++;
    const next = await deps.patientReader.findById({ organizationId, id: current.mergedIntoId });
    if (!next) {
      log("hl7.cascade.merge_dangling", {
        startPatientId: start.id,
        dangling: current.mergedIntoId,
        hops,
      });
      return { patient: null, hops };
    }
    current = next;
  }
  if (current?.mergedIntoId && hops >= MAX_MERGE_HOPS) {
    log("hl7.cascade.merge_hops_exceeded", { startPatientId: start.id, hops });
    return { patient: null, hops };
  }
  return { patient: current, hops };
}

/** A usable SSN last-four is exactly four digits and not the `0000` placeholder. */
export function isValidSsnLast4(s: string): boolean {
  return /^\d{4}$/.test(s) && s !== "0000";
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cascade_seam_timeout_${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
