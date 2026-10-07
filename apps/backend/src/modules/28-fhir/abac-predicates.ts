// apps/backend/src/modules/28-fhir/abac-predicates.ts — M28-T08 (§4.7 / §8.1).
//
// The SIX named ABAC predicate resolvers M28 registers into M3's named-predicate registry. Each is a
// typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes; every subject fact is
// loaded through the injected {@link FhirGatewayAbacResolver} (org-scoped, RLS-backstopped) — never read
// off the request body. The fail direction is UNIFORM: an unreadable resolver, an unknown target, an
// absent row, a cross-tenant id and a thrown error all DENY (§8.2 isolation shape).
//
// ── THREE ARE ROUTE-BOUND, THREE ARE REGISTERED-BUT-UNBOUND, AND BOTH ARE REQUIRED ──────────────────
//
//   BOUND at an admin route (routes/guards.ts):
//     · fhir_client_organization_scope   — the per-client admin routes (approve/revoke/suspend/rotate/
//       sessions): a `fhir_client` row is visible only to a membership in the row's own org.
//     · fhir_inbound_owner_module_match  — accept/reject a staged proposal (D8): only a reviewer holding
//       the owner module's native write path (m5 → patient demographics, m12 → medhx reconcile).
//     · bulk_export_initiator_or_admin   — cancel a job: its initiator, the bearer client, or a member
//       holding `fhir.export.bulk.cancel`.
//
//   REGISTERED but bound by NO §4.1 route in Phase 1 (the FHIR-spec bearer surface enforces them in the
//   handler, not through M3 — those routes carry no WardenX session for `requireAbac` to read):
//     · fhir_export_scope_satisfied      — requested `_type` ⊆ client `allowed_scopes` (bound at $export).
//     · fhir_client_active               — status=active AND (IP in allowlist if any) AND BAA active.
//     · fhir_export_recipient_authorized — per-resource M39 consent intersection at egress.
//
// M3's registry fails CLOSED on an UNKNOWN name, so a §4.7 predicate that exists only as a name nothing
// declares is a permanently dead endpoint the whole build stays green over (the M30 finding
// `arch:abac-predicates` was built for). All six are registered so "not yet bound" and "misspelled" stay
// distinguishable.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards
// on `abacRegistry.has`.
import {
  type AbacContext,
  type AbacTarget,
  hasOrgWideScope,
  registerPredicateIdempotent,
} from "@wardenx/auth";
import { fhirInboundIsPatientScoped } from "@wardenx/fhir";
import type { FhirInboundOwnerModule } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";

/** The §4.7 predicate names M28 OWNS (registered into M3). Single-owner across the platform registry. */
export const M28_FHIR_ABAC_PREDICATES = [
  "fhir_client_organization_scope",
  "fhir_inbound_owner_module_match",
  "fhir_export_scope_satisfied",
  "bulk_export_initiator_or_admin",
  "fhir_client_active",
  "fhir_export_recipient_authorized",
] as const;

export type M28RegisteredAbacPredicate = (typeof M28_FHIR_ABAC_PREDICATES)[number];

/**
 * §4.7 — the M3 permission key that PROVES the actor holds an owner module's native write path.
 *
 * A staged inbound proposal is only ever accepted through the module that will own the native record, so
 * `fhir_inbound_owner_module_match` checks the reviewer holds THAT module's write permission — a Patient
 * demographic proposal (m5) needs `patient.create`; a MedicationStatement medhx proposal (m12) needs
 * `prescribing.history.reconcile`, the carry-forward write that mints a draft. Neither is a role token:
 * §4.6 grants them to the clinical roles that already own the surface, and reusing the existing key is
 * what keeps M28 from re-deciding an authorization M5/M12 already own.
 */
export const FHIR_OWNER_MODULE_WRITE_PERMISSION: {
  readonly [K in FhirInboundOwnerModule]: string;
} = {
  m5: "patient.create",
  m12: "prescribing.history.reconcile",
};

/** The permission key that lets an operator cancel/read ANY job (`bulk_export_initiator_or_admin`). */
export const FHIR_BULK_EXPORT_CANCEL_PERMISSION = "fhir.export.bulk.cancel";

// ── the read surface M28's predicates resolve against (Drizzle in prod; in-memory in tests) ───────────

/** One `fhir_bulk_export_job` as `bulk_export_initiator_or_admin` reads it (§3.2). */
export interface FhirBulkExportJobAbacFacts {
  readonly jobId: string;
  readonly organizationId: string;
  readonly clientId: string;
  readonly initiatedByMembershipId: string | null;
}

/** What `fhir_inbound_owner_module_match` needs about the proposal's subject (GAP-198, migration 0490). */
export interface FhirInboundSubjectFacts {
  readonly resourceType: string;
  /** Stamped at staging; null = no resolvable chart (a new-patient intake, or an unresolvable subject). */
  readonly subjectPatientId: string | null;
}

/** One `fhir_client` as `fhir_client_active` reads it (§2.2/§2.3). */
export interface FhirClientActiveFacts {
  readonly organizationId: string;
  readonly status: string;
  readonly ipAllowlist: readonly string[];
  readonly baaActive: boolean;
}

/**
 * The read surface M28's predicates resolve against. EVERY METHOD IS THREE-VALUED where it matters:
 * `null` is "absent OR unreadable", and both DENY — telling them apart would let a caller enumerate the
 * registry by timing refusals.
 */
export interface FhirGatewayAbacResolver {
  /** The org a `fhir_client` row belongs to, or null when absent/unreadable. */
  clientOrgId(clientId: string): Promise<string | null>;
  /** The owner module a staged proposal resolves to, or null when absent/unreadable. */
  inboundOwnerModule(orgId: string, proposalId: string): Promise<FhirInboundOwnerModule | null>;
  /** The proposal's resource type + staged subject patient, or null when absent/unreadable (denies). */
  inboundSubjectPatient(orgId: string, proposalId: string): Promise<FhirInboundSubjectFacts | null>;
  /** Whether the membership holds an M3 permission key in this org. `null` ⇒ unreadable (denies). */
  holdsPermission(
    orgId: string,
    membershipId: string,
    permissionKey: string,
  ): Promise<boolean | null>;
  /** The client's granted resource types (`allowed_scopes` → `Patient`/`Encounter`/…). `null` ⇒ deny. */
  clientAllowedResourceTypes(clientId: string): Promise<readonly string[] | null>;
  /** The job's org + initiator + client, or null when absent/cross-tenant/unreadable. */
  loadBulkExportJob(orgId: string, jobId: string): Promise<FhirBulkExportJobAbacFacts | null>;
  /** The client's active-posture facts (status + IP allowlist + BAA), or null when absent/unreadable. */
  clientActiveFacts(clientId: string): Promise<FhirClientActiveFacts | null>;
  /** Whether M39 consent permits disclosing this patient to the recipient. `null` ⇒ unreadable (denies). */
  disclosureAllowed(
    orgId: string,
    patientId: string,
    recipientClientId: string,
  ): Promise<boolean | null>;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubFhirGatewayAbacResolver: FhirGatewayAbacResolver = {
  async clientOrgId() {
    return null;
  },
  async inboundOwnerModule() {
    return null;
  },
  async inboundSubjectPatient() {
    return null;
  },
  async holdsPermission() {
    return null;
  },
  async clientAllowedResourceTypes() {
    return null;
  },
  async loadBulkExportJob() {
    return null;
  },
  async clientActiveFacts() {
    return null;
  },
  async disclosureAllowed() {
    return null;
  },
};

export interface FhirGatewayAbacDeps {
  readonly resolver: FhirGatewayAbacResolver;
  /** Caseload membership check; defaults to the boot-registered M5 `CaseloadProvider` seam. */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

// ── target/context extraction (server-side only) ─────────────────────────────────────────────────────

function targetStr(target: AbacTarget, ...fields: readonly string[]): string | null {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function targetStrArray(target: AbacTarget, field: string): readonly string[] | null {
  const value = target[field];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  return null;
}

function membershipIdOf(context: AbacContext): string | null {
  const value = context.attributes?.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ── the predicates ───────────────────────────────────────────────────────────────────────────────────

/** Build M28's six §4.7 predicate resolvers over an injected read surface (unit-testable without seams). */
export function buildFhirGatewayAbacPredicates(
  deps: FhirGatewayAbacDeps,
): Record<
  M28RegisteredAbacPredicate,
  (context: AbacContext, target: AbacTarget) => Promise<boolean>
> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  return {
    /** §4.7 — a `fhir_client` row is visible only to a membership in the row's own org. */
    fhir_client_organization_scope: async (context, target) => {
      if (!context.organizationId) return false;
      const clientId = targetStr(target, "clientId", "id");
      if (clientId === null) return false;
      const org = await resolver.clientOrgId(clientId).catch(() => null);
      if (org === null) return false;
      return org === context.organizationId;
    },

    /**
     * §4.7 / D8 — accept/reject a staged proposal only through the owner module's native write path,
     * AND (GAP-198) only for a patient the reviewer may see: `caseload_or_scope` over the proposal's
     * `subject_patient_id`, stamped at staging. A patient-scoped resource (MedicationStatement) with no
     * resolvable subject DENIES; a new-patient `Patient` intake has no chart to scope and is gated by the
     * owner's `patient.create` alone.
     */
    fhir_inbound_owner_module_match: async (context, target) => {
      if (!context.organizationId) return false;
      const membershipId = membershipIdOf(context);
      if (membershipId === null) return false;
      const proposalId = targetStr(target, "proposalId", "id");
      if (proposalId === null) return false;
      const ownerModule = await resolver
        .inboundOwnerModule(context.organizationId, proposalId)
        .catch(() => null);
      if (ownerModule === null) return false;
      const key = FHIR_OWNER_MODULE_WRITE_PERMISSION[ownerModule];
      const held = await resolver
        .holdsPermission(context.organizationId, membershipId, key)
        .catch(() => null);
      if (held !== true) return false;

      const subject = await resolver
        .inboundSubjectPatient(context.organizationId, proposalId)
        .catch(() => null);
      if (subject === null) return false; // absent / unreadable
      if (subject.subjectPatientId === null)
        return !fhirInboundIsPatientScoped(subject.resourceType);
      if (hasOrgWideScope(context.roles ?? [])) return true;
      if (!context.userId) return false;
      try {
        return await isInCaseload({
          organizationId: context.organizationId,
          userId: context.userId,
          patientId: subject.subjectPatientId,
        });
      } catch {
        return false;
      }
    },

    /** §4.7 — requested `_type` set ⊆ the client's granted resource types (bound at $export). */
    fhir_export_scope_satisfied: async (_context, target) => {
      const clientId = targetStr(target, "clientId", "id");
      if (clientId === null) return false;
      const requested = targetStrArray(target, "resourceTypes") ?? [];
      const allowed = await resolver.clientAllowedResourceTypes(clientId).catch(() => null);
      if (allowed === null) return false;
      const allowedSet = new Set(allowed);
      return requested.every((t) => allowedSet.has(t));
    },

    /** §4.7 — a job may be cancelled/read by its initiator, the bearer client, or a cancel-permitted member. */
    bulk_export_initiator_or_admin: async (context, target) => {
      if (!context.organizationId) return false;
      const membershipId = membershipIdOf(context);
      const jobId = targetStr(target, "jobId", "id");
      if (jobId === null) return false;
      const job = await resolver.loadBulkExportJob(context.organizationId, jobId).catch(() => null);
      if (job === null) return false;
      if (job.organizationId !== context.organizationId) return false;
      if (membershipId !== null && job.initiatedByMembershipId === membershipId) return true;
      // The bearer client is the caller on the FHIR-spec DELETE path; on the admin path we fall through to
      // the operator arm — a member holding the cancel key may stand down any job in their org.
      if (membershipId === null) return false;
      const held = await resolver
        .holdsPermission(context.organizationId, membershipId, FHIR_BULK_EXPORT_CANCEL_PERMISSION)
        .catch(() => null);
      return held === true;
    },

    /** §4.7 — client status=active AND (IP allowlisted if the list is non-empty) AND BAA active. */
    fhir_client_active: async (context, target) => {
      const clientId = targetStr(target, "clientId", "id");
      if (clientId === null) return false;
      const facts = await resolver.clientActiveFacts(clientId).catch(() => null);
      if (facts === null) return false;
      if (facts.status !== "active") return false;
      if (!facts.baaActive) return false;
      if (facts.ipAllowlist.length > 0) {
        const ip = targetStr(target, "sourceIp", "ip");
        if (ip === null || !facts.ipAllowlist.includes(ip)) return false;
      }
      return true;
    },

    /** §4.7 / W-FHIR-03 — M39 consent permits disclosing this patient to the recipient client (egress). */
    fhir_export_recipient_authorized: async (context, target) => {
      if (!context.organizationId) return false;
      const patientId = targetStr(target, "patientId");
      const recipientClientId = targetStr(target, "recipientClientId", "clientId");
      if (patientId === null || recipientClientId === null) return false;
      const allowed = await resolver
        .disclosureAllowed(context.organizationId, patientId, recipientClientId)
        .catch(() => null);
      return allowed === true;
    },
  };
}

/**
 * Register M28's six §4.7 ABAC predicate resolvers into M3's shared registry (M28-T08; idempotent).
 *
 * Call at boot after the M28 stores are constructed (the resolver reads the same tables). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerFhirGatewayAbacPredicates(deps: FhirGatewayAbacDeps): void {
  const predicates = buildFhirGatewayAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
