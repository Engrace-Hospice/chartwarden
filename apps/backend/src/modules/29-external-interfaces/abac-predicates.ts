// apps/backend/src/modules/29-external-interfaces/abac-predicates.ts — M29-T08 (§4.8 / §8).
//
// The SIX named ABAC predicate resolvers M29 registers into M3's named-predicate registry (D20). Each is a
// typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes; every subject fact is
// loaded through the injected {@link M29AbacResolver} (org-scoped, RLS-backstopped) — never read off the
// request body. The fail direction is UNIFORM: an unreadable resolver, an unknown target, an absent row, a
// cross-tenant id and a thrown error all DENY (§8.2 isolation shape).
//
// ── WHICH ARE ROUTE-BOUND ──────────────────────────────────────────────────────────────────────────
//   · external_feed_organization_scope             — bound on the per-feed admin routes (guards.ts).
//   · external_feed_baa_satisfied                  — bound on POST /feeds/:id/activate (D16).
//   · external_feed_compliance_co_approver_distinct — bound on POST /feeds/:id/revoke (dual-approval, D20).
//   · hl7_inbound_proposal_owner_module_match      — bound on proposal accept/reject.
//   · nppes_platform_job_caller                    — bound on POST /nppes/sync-runs (W-XI-12 platform-only).
//   · lab_observation_patient_caseload_or_scope    — bound on the clinician lab reads + unmatched writes.
//
// M3's registry fails CLOSED on an UNKNOWN name (the `arch:abac-predicates` gate), so all six are registered
// even where the Phase-1 binding denies by construction (the tenant request context carries no
// platform-operator fact, so `nppes_platform_job_caller` denies until a platform-role caller exists) — a
// registered-but-denying predicate stays distinguishable from a misspelled one.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so a re-boot (tests) guards
// on `abacRegistry.has`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import type { Hl7ProposalOwnerModule } from "@wardenx/types";

/** The §4.8 predicate names M29 OWNS (registered into M3). Single-owner across the platform registry. */
export const M29_ABAC_PREDICATES = [
  "external_feed_organization_scope",
  "hl7_inbound_proposal_owner_module_match",
  "lab_observation_patient_caseload_or_scope",
  "external_feed_compliance_co_approver_distinct",
  "nppes_platform_job_caller",
  "external_feed_baa_satisfied",
] as const;

export type M29RegisteredAbacPredicate = (typeof M29_ABAC_PREDICATES)[number];

/**
 * §4.8 — the M3 permission key that PROVES the actor holds an owner module's native write path.
 *
 * An ADT proposal is only ever accepted through the module that will own the native record (D5): a
 * demographic-update proposal (`owner_module='m5'`) applies through M5's `PatientMutator`, so the reviewer
 * must hold `patient.create`; an admission/discharge/cancel proposal (`owner_module='m6'`) applies through
 * M6's admission applier, so the reviewer must hold `admission.create`. Reusing the existing key is what
 * keeps M29 from re-deciding an authorization M5/M6 already own.
 */
export const HL7_OWNER_MODULE_WRITE_PERMISSION: {
  readonly [K in Hl7ProposalOwnerModule]: string;
} = {
  m5: "patient.create",
  m6: "admission.create",
};

// ── the read surface M29's predicates resolve against (Drizzle in prod; in-memory in tests) ───────────

/** One `hl7_inbound_proposal` as `hl7_inbound_proposal_owner_module_match` reads it. */
export interface Hl7ProposalAbacFacts {
  readonly organizationId: string;
  readonly ownerModule: Hl7ProposalOwnerModule;
}

/** One `lab_observation` as `lab_observation_patient_caseload_or_scope` reads it. */
export interface LabObservationAbacFacts {
  readonly organizationId: string;
  /** The matched patient (a `lab_observation` always has one; the unmatched queue reads inbound-links). */
  readonly patientId: string | null;
}

/**
 * The read surface M29's predicates resolve against. EVERY METHOD IS THREE-VALUED where it matters: `null`
 * is "absent OR unreadable", and both DENY — telling them apart would let a caller enumerate the registry
 * by timing refusals.
 */
export interface M29AbacResolver {
  /** The org a `external_feed` row belongs to, or null when absent/unreadable. */
  feedOrgId(feedId: string): Promise<string | null>;
  /** The proposal's org + owner module, or null when absent/cross-tenant/unreadable. */
  proposalFacts(orgId: string, proposalId: string): Promise<Hl7ProposalAbacFacts | null>;
  /** The observation's org + matched patient, or null when absent/cross-tenant/unreadable. */
  observationFacts(orgId: string, observationId: string): Promise<LabObservationAbacFacts | null>;
  /** Whether the membership holds an M3 permission key in this org. `null` ⇒ unreadable (denies). */
  holdsPermission(
    orgId: string,
    membershipId: string,
    permissionKey: string,
  ): Promise<boolean | null>;
  /** Whether `userId` has `patientId` on their active caseload. `null` ⇒ unreadable (denies). */
  isInCaseload(orgId: string, userId: string, patientId: string): Promise<boolean | null>;
  /** Whether the feed's M40 BAA gate is satisfied (or the feed kind requires none). `null` ⇒ deny. */
  feedBaaSatisfied(orgId: string, feedId: string): Promise<boolean | null>;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubM29AbacResolver: M29AbacResolver = {
  async feedOrgId() {
    return null;
  },
  async proposalFacts() {
    return null;
  },
  async observationFacts() {
    return null;
  },
  async holdsPermission() {
    return null;
  },
  async isInCaseload() {
    return null;
  },
  async feedBaaSatisfied() {
    return null;
  },
};

export interface M29AbacDeps {
  readonly resolver: M29AbacResolver;
}

// ── target/context extraction (server-side only) ─────────────────────────────────────────────────────

function targetStr(target: AbacTarget, ...fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function membershipIdOf(context: AbacContext): string | null {
  const value = context.attributes?.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isPlatformOperator(context: AbacContext): boolean {
  // The platform NPPES sync runs under `withPlatformContext`, which a tenant HTTP session never carries.
  // Until a platform-operator caller is provisioned this reads false and the predicate denies (W-XI-12).
  return context.attributes?.isPlatformOperator === true;
}

// ── the predicates ───────────────────────────────────────────────────────────────────────────────────

/** Build M29's six §4.8 predicate resolvers over an injected read surface (unit-testable without seams). */
export function buildM29AbacPredicates(
  deps: M29AbacDeps,
): Record<M29RegisteredAbacPredicate, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;

  return {
    /** §4.8 — a `external_feed` row is visible only to a membership in the row's own org. */
    external_feed_organization_scope: async (context, target) => {
      if (!context.organizationId) return false;
      const feedId = targetStr(target, "feedId", "id");
      if (feedId === null) return false;
      const org = await resolver.feedOrgId(feedId).catch(() => null);
      if (org === null) return false;
      return org === context.organizationId;
    },

    /** §4.8 / D5 — accept/reject an ADT proposal only through the owner module's native write path. */
    hl7_inbound_proposal_owner_module_match: async (context, target) => {
      if (!context.organizationId) return false;
      const membershipId = membershipIdOf(context);
      if (membershipId === null) return false;
      const proposalId = targetStr(target, "proposalId", "id");
      if (proposalId === null) return false;
      const facts = await resolver
        .proposalFacts(context.organizationId, proposalId)
        .catch(() => null);
      if (facts === null) return false;
      if (facts.organizationId !== context.organizationId) return false;
      const key = HL7_OWNER_MODULE_WRITE_PERMISSION[facts.ownerModule];
      const held = await resolver
        .holdsPermission(context.organizationId, membershipId, key)
        .catch(() => null);
      return held === true;
    },

    /** §4.8 — the actor has the observation's patient in their caseload OR holds a wide-scope role. */
    lab_observation_patient_caseload_or_scope: async (context, target) => {
      if (!context.organizationId || !context.userId) return false;
      const observationId = targetStr(target, "observationId", "id");
      if (observationId === null) return false;
      const facts = await resolver
        .observationFacts(context.organizationId, observationId)
        .catch(() => null);
      if (facts === null) return false;
      if (facts.organizationId !== context.organizationId) return false;
      const membershipId = membershipIdOf(context);
      // Wide-scope arm: a role holding the unmatched-review key (Compliance Officer / Lab Coordinator /
      // DON / Medical Director are §4.7-granted it) reads across the org.
      if (membershipId !== null) {
        const wide = await resolver
          .holdsPermission(
            context.organizationId,
            membershipId,
            "external_interfaces.lab.review_unmatched",
          )
          .catch(() => null);
        if (wide === true) return true;
      }
      // An unmatched observation (no patient) is only reachable by the wide-scope arm above.
      if (facts.patientId === null) return false;
      const inCaseload = await resolver
        .isInCaseload(context.organizationId, context.userId, facts.patientId)
        .catch(() => null);
      return inCaseload === true;
    },

    /** §4.8 — the feed-revoke co-approver must be a DIFFERENT person from the primary approver (D20). */
    external_feed_compliance_co_approver_distinct: async (context, target) => {
      if (!context.organizationId) return false;
      const membershipId = membershipIdOf(context);
      if (membershipId === null) return false;
      const primaryApproverId = targetStr(target, "primaryApproverId", "approvedByOpId");
      // No primary approver on file yet ⇒ this IS the first approver; distinctness is trivially met.
      if (primaryApproverId === null) return true;
      return membershipId !== primaryApproverId;
    },

    /** §4.8 — a tenant-scoped role cannot trigger a platform-shared NPPES sync (W-XI-12). */
    nppes_platform_job_caller: async (context) => {
      return isPlatformOperator(context);
    },

    /** §4.8 / D16 — the feed's M40 BAA gate is satisfied before activation / outbound dispatch. */
    external_feed_baa_satisfied: async (context, target) => {
      if (!context.organizationId) return false;
      const feedId = targetStr(target, "feedId", "id");
      if (feedId === null) return false;
      const ok = await resolver.feedBaaSatisfied(context.organizationId, feedId).catch(() => null);
      return ok === true;
    },
  };
}

/**
 * Register M29's six §4.8 ABAC predicate resolvers into M3's shared registry (M29-T08; idempotent).
 *
 * Call at boot after the M29 stores are constructed (the resolver reads the same tables). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerM29AbacPredicates(deps: M29AbacDeps): void {
  const predicates = buildM29AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
