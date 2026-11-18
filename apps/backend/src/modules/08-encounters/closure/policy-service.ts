// apps/backend/src/modules/08-encounters/closure/policy-service.ts — the per-tenant visit-note closure policy (ADR-0113 D4).
//
// One row per (organization, obligation kind) in `documentation_obligation_policy`: what an overdue note does (off | warn |
// block) and how many hours the clinician has. An ABSENT row means warn / 24 hours, applied here in code (main auto-deploys,
// so the default must never block). Moving a tenant to `block`, or LOWERING the threshold while it stays in `block`, stamps
// `enforce_from = now` SERVER-SIDE so notes that are already overdue get a fresh window (`blockFrom = max(clock, enforce_from)
// + threshold`, see note-clock.ts) instead of locking clinicians out on the switch. Every write also records an explicit
// `m8.encounter.closure_policy_changed` audit event (previous and new mode / threshold). Slice 1 accepts only the `visit_note`
// kind at the API; the other kinds are reserved.
//
// The service takes the caller's transaction (`withOrgContext` upstream) so RLS scopes every row; it never opens its own.
import { type AuditContext, audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import {
  ACTIVE_DOCUMENTATION_OBLIGATION_KINDS,
  DOCUMENTATION_OBLIGATION_DEFAULT_MODE,
  DOCUMENTATION_OBLIGATION_DEFAULT_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MODES,
  type DocumentationObligationKind,
  type DocumentationObligationMode,
  ValidationError,
} from "@chartwarden/types";
import { and, eq } from "drizzle-orm";

/** The in-process cache window the request-time gate reads the policy through. */
export const CLOSURE_POLICY_CACHE_TTL_MS = 5_000;

/** The explicit audit event a policy write records (catalogued in `M8_ACTION_CATALOG`); the row trigger records the row change too. */
export const CLOSURE_POLICY_AUDIT_EVENT = "m8.encounter.closure_policy_changed";

/** A tenant's effective policy for one obligation kind (the absent-row default already applied). */
export interface ClosurePolicy {
  readonly mode: DocumentationObligationMode;
  readonly thresholdHours: number;
  /** Set whenever the mode moves to `block`; only ever delays the block instant. `null` = no grace. */
  readonly enforceFrom: Date | null;
}

export const DEFAULT_CLOSURE_POLICY: ClosurePolicy = Object.freeze({
  mode: DOCUMENTATION_OBLIGATION_DEFAULT_MODE,
  thresholdHours: DOCUMENTATION_OBLIGATION_DEFAULT_THRESHOLD_HOURS,
  enforceFrom: null,
});

const P = schema.documentationObligationPolicies;

/** The organization's policy for `kind`, or the default when it has never configured one. */
export async function readClosurePolicy(
  tx: DbClient,
  organizationId: string,
  kind: DocumentationObligationKind,
): Promise<ClosurePolicy> {
  const [row] = await tx
    .select({ mode: P.mode, thresholdHours: P.thresholdHours, enforceFrom: P.enforceFrom })
    .from(P)
    .where(and(eq(P.organizationId, organizationId), eq(P.obligationKind, kind)))
    .limit(1);
  if (!row) return DEFAULT_CLOSURE_POLICY;
  return { mode: row.mode, thresholdHours: row.thresholdHours, enforceFrom: row.enforceFrom };
}

/**
 * The grace instant after a write. Blocking restarts with a fresh window (`now`) whenever it starts or its effective deadline moves
 * EARLIER: the mode moves to block, or it stays block and the threshold is lowered (a lower threshold would otherwise put every
 * older open note's `blockFrom` in the past at once, with no grace). It keeps the original instant while the mode stays block and
 * the threshold is unchanged or raised (a repeated PUT is idempotent; nobody is newly late), and is `null` once the mode leaves
 * block. The instant never moves earlier. Pure.
 */
export function nextEnforceFrom(
  previous: ClosurePolicy,
  nextMode: DocumentationObligationMode,
  now: Date,
  nextThresholdHours: number,
): Date | null {
  if (nextMode !== "block") return null;
  if (previous.mode !== "block") return now;
  const deadlineMovedEarlier = nextThresholdHours < previous.thresholdHours;
  if (!deadlineMovedEarlier) return previous.enforceFrom;
  const kept = previous.enforceFrom;
  return kept !== null && kept.getTime() > now.getTime() ? kept : now;
}

export interface PutClosurePolicyInput {
  readonly organizationId: string;
  readonly obligationKind: DocumentationObligationKind;
  readonly mode: DocumentationObligationMode;
  readonly thresholdHours: number;
  /** The Better Auth USER id (`documentation_obligation_policy.configured_by_user_id` references `user`). */
  readonly actorUserId: string;
  /** The request's audit context (organization, acting user, correlation id) for the explicit audit event. */
  readonly audit: AuditContext;
  /** Injected for tests; defaults to the server clock. */
  readonly now?: Date;
}

function refuse(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

function assertValidPut(input: PutClosurePolicyInput): void {
  if (!ACTIVE_DOCUMENTATION_OBLIGATION_KINDS.includes(input.obligationKind)) {
    refuse(
      "obligationKind",
      `only ${ACTIVE_DOCUMENTATION_OBLIGATION_KINDS.join(", ")} is configurable`,
    );
  }
  if (!DOCUMENTATION_OBLIGATION_MODES.includes(input.mode)) {
    refuse("mode", `mode must be one of ${DOCUMENTATION_OBLIGATION_MODES.join(", ")}`);
  }
  const hours = input.thresholdHours;
  const inRange =
    Number.isInteger(hours) &&
    hours >= DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS &&
    hours <= DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS;
  if (!inRange) {
    refuse(
      "thresholdHours",
      `thresholdHours must be a whole number from ${DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS} to ${DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS}`,
    );
  }
}

/**
 * Idempotent upsert of the tenant's policy. Validates before any IO (kind, mode, threshold 1..168), derives `enforce_from`
 * server-side, writes the explicit `m8.encounter.closure_policy_changed` audit event on the same transaction (severity warn,
 * previous and new mode / threshold, no free text) and returns the effective policy written. The M4 audit trigger records the row
 * change too.
 *
 * ponytail: read-then-upsert, no row lock. Two concurrent PUTs both converge on the same primary key and the later write wins;
 * the only skew is which one stamps `enforce_from`, and both stamp "now". Add SELECT ... FOR UPDATE if policy edits ever race.
 */
export async function putClosurePolicy(
  tx: DbClient,
  input: PutClosurePolicyInput,
): Promise<ClosurePolicy> {
  assertValidPut(input);
  const now = input.now ?? new Date();
  const previous = await readClosurePolicy(tx, input.organizationId, input.obligationKind);
  const enforceFrom = nextEnforceFrom(previous, input.mode, now, input.thresholdHours);
  const written = { mode: input.mode, thresholdHours: input.thresholdHours, enforceFrom };
  await tx
    .insert(P)
    .values({
      organizationId: input.organizationId,
      obligationKind: input.obligationKind,
      ...written,
      configuredByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [P.organizationId, P.obligationKind],
      set: { ...written, configuredByUserId: input.actorUserId, updatedAt: now },
    });
  await audit(tx, input.audit, {
    eventType: CLOSURE_POLICY_AUDIT_EVENT,
    resourceKind: "documentation_obligation_policy",
    // The policy's key is (organization, kind): the row trigger's resource id is the organization too.
    resourceId: input.organizationId,
    outcome: "success",
    severity: "warn",
    retentionClass: "compliance",
    after: {
      obligationKind: input.obligationKind,
      previousMode: previous.mode,
      previousThresholdHours: previous.thresholdHours,
      mode: written.mode,
      thresholdHours: written.thresholdHours,
      enforceFrom: enforceFrom === null ? null : enforceFrom.toISOString(),
    },
  });
  return written;
}

/** The gate's read path: a per-(org, kind) cache that never keeps a failure and can be dropped per organization. */
export interface ClosurePolicyCache {
  get(organizationId: string, kind: DocumentationObligationKind): Promise<ClosurePolicy>;
  /** Drop every cached kind for the organization (the PUT route calls this so the gate sees the change at once on this replica). */
  invalidate(organizationId: string): void;
}

export interface ClosurePolicyCacheOptions {
  readonly load: (
    organizationId: string,
    kind: DocumentationObligationKind,
  ) => Promise<ClosurePolicy>;
  readonly ttlMs?: number;
  /** Injected for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly pending: Promise<ClosurePolicy>;
}

const cacheKey = (organizationId: string, kind: DocumentationObligationKind): string =>
  `${organizationId}:${kind}`;

/**
 * An in-process TTL cache (default 5s) with in-flight de-duplication. A rejected load is evicted so the next read retries.
 *
 * ponytail: per-replica and unbounded by organization count (one entry per org and kind that a request has touched). Another
 * replica sees a PUT within the TTL, not at once; add a Valkey pub/sub invalidation only if that lag is ever unacceptable.
 */
export function createClosurePolicyCache(options: ClosurePolicyCacheOptions): ClosurePolicyCache {
  const ttlMs = options.ttlMs ?? CLOSURE_POLICY_CACHE_TTL_MS;
  const clock = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  return {
    get(organizationId, kind) {
      const key = cacheKey(organizationId, kind);
      const cached = entries.get(key);
      if (cached && cached.expiresAt > clock()) return cached.pending;
      const pending = options.load(organizationId, kind);
      entries.set(key, { expiresAt: clock() + ttlMs, pending });
      pending.catch(() => {
        if (entries.get(key)?.pending === pending) entries.delete(key);
      });
      return pending;
    },
    invalidate(organizationId) {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(`${organizationId}:`)) entries.delete(key);
      }
    },
  };
}
