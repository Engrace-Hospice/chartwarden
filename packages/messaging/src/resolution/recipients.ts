// @chartwarden/messaging — recipient resolution registry (M36-T04, spec §2.1 principle 3, §4.6, §2.5).
//
// Recipient resolution is DYNAMIC at emit time, not frozen on the rule (§2.1.3): `alert_rule`
// names a `RecipientResolver` (care_team / on_call / discipline / role_set / tenant_admins /
// user_list / broadcast), and the resolver consults the source-of-truth seam at emit time — so
// on-call escalation reaches whoever is on shift *now*, not who was when the rule was written.
//
// This file is the pure registry + dispatcher. The source-of-truth lookups are injected `ports`
// (M5 caseload, M19 on-call, M2 role/membership) — wired to real seams at boot (M36-T06); tests
// inject fakes. The registry is OPEN: the ADR-0024 cross-module composition resolvers (§4.6
// ordering_provider / intake_supervisor / admissions_team) register at M36-T09 without changing
// this core. §2.5 "recipient_resolver must be in the registered set" is enforced here: an
// unknown name throws rather than silently resolving to nobody.

import type { AlertRecipientResolver } from "../interfaces/kinds";

/** Structured args off `alert_rule.resolver_args` (§3.6). Resolvers read only what they need;
 *  the `*Path` keys name where in the event payload to find a subject id (§4.6 `care_team(patient_id)`). */
export interface ResolverArgs {
  readonly disciplines?: readonly string[];
  readonly roleKeys?: readonly string[];
  readonly userIds?: readonly string[];
  /** `role_set` only — payload keys that each hold a user id (a string) OR a list of user ids (string[]) to add
   *  to the role audience: per-event audience members the role set cannot express (an IDG meeting's coordinator, a
   *  meeting's expected attendees, an action item's assignee). Absent/non-string values are skipped; the
   *  producer-side consumer is responsible for putting only ACTIVE org members' user ids there. */
  readonly userIdPaths?: readonly string[];
  /** `role_set` only — a payload key holding a list of role keys (string[]) added to `roleKeys`: a per-event
   *  audience TIER (e.g. the IDG review-clock escalation adds the clinical supervisor at T-0 and the compliance
   *  officer at T+1). Set by the trusted producer-side consumer, never by request input; absent/non-string
   *  entries are skipped. */
  readonly roleKeysPath?: string;
  /** `role_set` only — role keys resolved ONLY among members assigned to the provider entity named by the
   *  payload's `providerEntityIdPath` key (default `providerEntityId`), via `roleSetMembersForProviderEntity`.
   *  Added to the org-wide `roleKeys` audience. */
  readonly providerEntityScopedRoleKeys?: readonly string[];
  /** `role_set` only — role keys resolved ORG-WIDE, but only when the PE-scoped audience resolved nobody (no
   *  PE on the payload, an unbound port, or no member assigned to that PE): the narrowing never leaves an
   *  alert with no recipient. */
  readonly providerEntityFallbackRoleKeys?: readonly string[];
  /** `permission_holders` only - the permission keys whose holders are the audience (exact keys, no wildcards). */
  readonly permissionKeys?: readonly string[];
  /** `permission_holders` only - role keys whose members are ALSO in the audience (an escalation tier). */
  readonly alsoRoleKeys?: readonly string[];
  /** `permission_holders` only - when nobody resolves, fall back to the org administrators so the alert is
   *  never addressed to an empty audience (permissions are granted per tenant, never by template). */
  readonly fallbackToTenantAdmins?: boolean;
  /** Payload key holding the patient id for `care_team` (default `patientId`). */
  readonly patientIdPath?: string;
  /** Payload key holding the provider entity id for `on_call` (default `providerEntityId`). */
  readonly providerEntityIdPath?: string;
  readonly [k: string]: unknown;
}

/** A resolver computes recipient `user_id`s from the org, the rule's args, and the event payload. */
export type RecipientResolverFn = (
  orgId: string,
  args: ResolverArgs,
  payload: Record<string, unknown>,
) => Promise<readonly string[]>;

/**
 * The source-of-truth lookups the built-in resolvers delegate to — each backed by a seam or M2
 * state at boot (M36-T06). Kept as plain async ports so the resolution core is pure and testable.
 */
export interface RecipientSourcePorts {
  /** M5/M17 CareTeamProvider seam — entitled members of a patient's care team. */
  careTeamMembers(orgId: string, patientId: string): Promise<readonly string[]>;
  /** M19 OnCallProvider seam — who is on shift for this provider entity right now. */
  onCallMembers(orgId: string, providerEntityId: string): Promise<readonly string[]>;
  /** M2 membership filtered by discipline role(s). */
  disciplineMembers(orgId: string, disciplines: readonly string[]): Promise<readonly string[]>;
  /** M2 membership filtered by an explicit role-key set. */
  roleSetMembers(orgId: string, roleKeys: readonly string[]): Promise<readonly string[]>;
  /** M2 membership filtered by a role-key set AND assignment to one provider entity (its default PE).
   *  Optional: an unbound port reads as "nobody resolvable", so the rule's org-wide fallback applies. */
  roleSetMembersForProviderEntity?(
    orgId: string,
    roleKeys: readonly string[],
    providerEntityId: string,
  ): Promise<readonly string[]>;
  /** Active members whose live, enabled, non-expired role grants ANY of these permission keys (the
   *  `permission_holders` resolver). Optional: an unbound port reads as "nobody", so the rule's tenant-admin
   *  floor applies. */
  permissionHolders?(orgId: string, permissionKeys: readonly string[]): Promise<readonly string[]>;
  /** Org administrators (the `tenant_admins` resolver). */
  tenantAdmins(orgId: string): Promise<readonly string[]>;
  /** Every active member of the org (the `broadcast` resolver). */
  orgMembers(orgId: string): Promise<readonly string[]>;
}

/** Thrown when a rule names a resolver that is not in the registered set (§2.5). The dispatch
 *  refuses rather than fanning out to an empty recipient list. */
export class UnknownRecipientResolverError extends Error {
  constructor(public readonly resolverName: string) {
    super(`unknown_recipient_resolver: ${resolverName}`);
    this.name = "UnknownRecipientResolverError";
  }
}

function readPath(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** A payload value that is one non-empty string OR an array of them → the non-empty strings (else `[]`). */
function readStrings(payload: Record<string, unknown>, key: string): string[] {
  const v = payload[key];
  if (typeof v === "string") return v.length > 0 ? [v] : [];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
}

/** A resolver arg that must be a list of non-empty strings; anything else reads as an empty list. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((x): x is string => typeof x === "string" && x.length > 0))]
    : [];
}

/** De-duplicate user ids, preserving first-seen order so delivery rows are deterministic. */
function dedupe(userIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of userIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * `role_set` PE narrowing: the members of `providerEntityScopedRoleKeys` assigned to the payload's provider
 * entity; when none resolve, the org-wide `providerEntityFallbackRoleKeys` (never an empty audience by
 * construction of the narrowing alone).
 */
async function resolvePeScoped(
  ports: RecipientSourcePorts,
  orgId: string,
  args: ResolverArgs,
  payload: Record<string, unknown>,
): Promise<readonly string[]> {
  const scopedKeys = args.providerEntityScopedRoleKeys ?? [];
  if (scopedKeys.length === 0) return [];
  const providerEntityId = readPath(payload, args.providerEntityIdPath ?? "providerEntityId");
  const scoped =
    providerEntityId === null || ports.roleSetMembersForProviderEntity === undefined
      ? []
      : await ports.roleSetMembersForProviderEntity(
          orgId,
          [...new Set(scopedKeys)],
          providerEntityId,
        );
  if (scoped.length > 0) return scoped;
  const fallbackKeys = args.providerEntityFallbackRoleKeys ?? [];
  return fallbackKeys.length === 0 ? [] : ports.roleSetMembers(orgId, [...new Set(fallbackKeys)]);
}

/**
 * Build the registry of the seven built-in resolvers (§4.6) over the injected source ports.
 * Returns a mutable map so later modules can `register` their ADR-0024 composition resolvers
 * (M36-T09) onto the same registry without importing this file's internals.
 */
export function createRecipientResolverRegistry(
  ports: RecipientSourcePorts,
): Map<string, RecipientResolverFn> {
  const registry = new Map<string, RecipientResolverFn>();

  const builtins: { readonly [N in AlertRecipientResolver]: RecipientResolverFn } = {
    care_team: async (orgId, args, payload) => {
      const patientId = readPath(payload, args.patientIdPath ?? "patientId");
      return patientId === null ? [] : ports.careTeamMembers(orgId, patientId);
    },
    on_call: async (orgId, args, payload) => {
      const providerEntityId = readPath(payload, args.providerEntityIdPath ?? "providerEntityId");
      return providerEntityId === null ? [] : ports.onCallMembers(orgId, providerEntityId);
    },
    discipline: async (orgId, args) => ports.disciplineMembers(orgId, args.disciplines ?? []),
    role_set: async (orgId, args, payload) => {
      const roleKeys = [
        ...(args.roleKeys ?? []),
        ...(args.roleKeysPath === undefined ? [] : readStrings(payload, args.roleKeysPath)),
      ];
      const fromRoles = await ports.roleSetMembers(orgId, [...new Set(roleKeys)]);
      const fromPayload = (args.userIdPaths ?? []).flatMap((k) => readStrings(payload, k));
      const fromPe = await resolvePeScoped(ports, orgId, args, payload);
      return [...fromRoles, ...fromPe, ...fromPayload];
    },
    tenant_admins: async (orgId) => ports.tenantAdmins(orgId),
    permission_holders: async (orgId, args) => {
      const permissionKeys = stringList(args.permissionKeys);
      const holders =
        permissionKeys.length === 0 || ports.permissionHolders === undefined
          ? []
          : await ports.permissionHolders(orgId, permissionKeys);
      const alsoRoleKeys = stringList(args.alsoRoleKeys);
      const escalation =
        alsoRoleKeys.length === 0 ? [] : await ports.roleSetMembers(orgId, alsoRoleKeys);
      const audience = [...holders, ...escalation];
      return audience.length === 0 && args.fallbackToTenantAdmins === true
        ? ports.tenantAdmins(orgId)
        : audience;
    },
    // user_list is fully static — the one resolver with no source-of-truth port (§3.6 userIds).
    user_list: async (_orgId, args) => args.userIds ?? [],
    broadcast: async (orgId) => ports.orgMembers(orgId),
  };

  for (const [name, fn] of Object.entries(builtins)) registry.set(name, fn);
  return registry;
}

/**
 * Resolve the recipient `user_id`s for an alert at emit time (§2.1.3). Dispatches to the named
 * resolver, de-duplicates, and preserves order. Throws {@link UnknownRecipientResolverError}
 * when the name is not registered (§2.5) — never a silent empty fan-out for a typo'd rule.
 */
export async function resolveRecipients(
  registry: ReadonlyMap<string, RecipientResolverFn>,
  resolverName: string,
  orgId: string,
  args: ResolverArgs,
  payload: Record<string, unknown>,
): Promise<string[]> {
  const resolver = registry.get(resolverName);
  if (resolver === undefined) throw new UnknownRecipientResolverError(resolverName);
  return dedupe(await resolver(orgId, args, payload));
}
