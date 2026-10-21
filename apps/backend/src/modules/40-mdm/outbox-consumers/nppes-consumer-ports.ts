// apps/backend/src/modules/40-mdm/outbox-consumers/nppes-consumer-ports.ts — the PRODUCTION
// {@link NppesConsumerPorts} binding for M40's §4.7 NPPES appliers (GAP-099).
//
// The DECISION logic has been shipped and unit-tested in `packages/mdm` since M40-T09
// (`handleProviderSynced` / `handleProviderDeactivated`). What never existed was anything to bind it to:
// the canonical tables had no write path at all (migration 0019 created `mdm_canonical_writer`, its
// policies and its grants, then never wrote a function that owns them — see migration 0202), and the
// dispatcher could not deliver a platform-wide event to a consumer (see migration 0201 + the
// `PlatformOutboxConsumerBinding` type). Both are now built; this file is the adapter between them.
//
// THE FOUR WRITE/READ SHAPES, and why each takes the path it does:
//   · canonical READ — `external_physician` is org-less with a `USING (true)` read policy for
//     `chartwarden_app`, so this is a plain query on the pooled handle. No org context exists to set.
//   · canonical WRITE — through the migration-0202 SECURITY DEFINER functions. `chartwarden_app` holds SELECT
//     and nothing else on the table; that is §3.6's deliberate posture and this adapter does not weaken it.
//   · outbox EMIT — platform-wide (`organizationId: null`), because a canonical change belongs to no
//     tenant. Routes through the migration-0186 SECURITY DEFINER insert inside the publisher.
//   · per-tenant ALERT — the only genuinely org-scoped step, so it is the only one that opens
//     `withOrgContext`, once per candidate org.
import { type DbClient, schema } from "@chartwarden/db";
import type { NppesCanonicalPhysician, NppesConsumerPorts } from "@chartwarden/mdm";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, ne, sql } from "drizzle-orm";

const PHYSICIAN = schema.externalPhysicians;
const OVERLAY = schema.externalPhysicianOverlay;

/** The M1 outbox publish port, restated locally so this module takes no bootstrap import edge. */
export interface M40OutboxPublishPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: unknown;
      readonly organizationId: string | null;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The M36 AlertEmitter seam, restated structurally (M40 does not import M36). */
export interface M40AlertPort {
  emit(
    organizationId: string,
    input: {
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
      readonly severity: string;
      readonly correlationId: string;
    },
  ): Promise<unknown>;
}

/** The M1 active-org enumerator (structurally; the bootstrap `ActiveOrgEnumerator`). */
export interface M40ActiveOrgPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M40NppesConsumerDeps {
  readonly db: DbClient;
  readonly outbox: M40OutboxPublishPort;
  readonly alerts: M40AlertPort;
  readonly orgs: M40ActiveOrgPort;
  /** Injected clock (tests pin it; production leaves it). */
  readonly now?: () => Date;
}

/** What one handled event actually did — read back by the binding to shape its own outbox emit. */
export interface NppesApplyRecord {
  canonicalId: string | null;
  changedFields: readonly string[];
  alertedOrganizationIds: readonly string[];
}

/**
 * Build the production ports plus the per-invocation record the caller reads afterwards. One instance per
 * handled event: {@link NppesApplyRecord} is mutable and would otherwise bleed between deliveries.
 */
export function buildNppesConsumerPorts(deps: M40NppesConsumerDeps): {
  readonly ports: NppesConsumerPorts;
  readonly record: NppesApplyRecord;
} {
  const now = deps.now ?? (() => new Date());
  const record: NppesApplyRecord = {
    canonicalId: null,
    changedFields: [],
    alertedOrganizationIds: [],
  };

  const ports: NppesConsumerPorts = {
    async findCanonicalByNpi(npi) {
      const [row] = await deps.db
        .select({
          id: PHYSICIAN.id,
          npi: PHYSICIAN.npi,
          status: PHYSICIAN.status,
          firstName: PHYSICIAN.firstName,
          lastName: PHYSICIAN.lastName,
          credentials: PHYSICIAN.credentials,
          specialtyTaxonomy: PHYSICIAN.specialtyTaxonomy,
        })
        .from(PHYSICIAN)
        // `merged` rows are tombstones redirecting to a survivor (§2.4.1). Excluded here rather than in
        // the writer so the DECISION also sees "no canonical" — applying registry data to a tombstone,
        // or reporting `no_op` because the tombstone's stale fields happen to match, are both wrong.
        .where(and(eq(PHYSICIAN.npi, npi), ne(PHYSICIAN.status, "merged")))
        .limit(1);
      if (!row || row.npi === null) return null;
      record.canonicalId = row.id;
      return { ...row, npi: row.npi } as NppesCanonicalPhysician;
    },

    async applyCanonicalUpdate(canonicalId, updates) {
      // The pure decision returns camelCase field names (it is written against the TS projection); the
      // migration-0202 function selects columns by jsonb KEY PRESENCE, so the keys must be column names.
      const patch: Record<string, unknown> = {};
      if ("firstName" in updates) patch.first_name = updates.firstName;
      if ("lastName" in updates) patch.last_name = updates.lastName;
      if ("credentials" in updates) patch.credentials = updates.credentials;
      if ("specialtyTaxonomy" in updates) patch.specialty_taxonomy = updates.specialtyTaxonomy;
      if ("nppesProvenance" in updates) patch.nppes_provenance = updates.nppesProvenance;
      patch.nppes_last_synced_at = now().toISOString();

      const result = await deps.db.execute(
        sql`SELECT mdm_canonical_writer_apply_nppes_update(${canonicalId}, ${JSON.stringify(patch)}::jsonb) AS applied`,
      );
      const applied = Number(
        (result as unknown as { rows?: Array<{ applied?: number }> }).rows?.[0]?.applied ?? 0,
      );
      // 0 rows means the canonical was deleted or merged between the read and the write. Throwing puts
      // the event back on the retry clock, where the next attempt's own lookup will see the new truth —
      // far better than logging a success for a write that touched nothing.
      if (applied === 0) {
        throw new Error(
          `m40 canonical ${canonicalId} matched no updatable row (deleted or merged mid-apply)`,
        );
      }
    },

    async applyDeactivation(canonicalId) {
      const provenance = {
        lastSyncedAt: now().toISOString(),
        lastSyncSource: "m29_platform_sync",
        lastChangedFields: ["status"],
        deactivationSource: "m29_platform_sync_nppes",
      };
      // No zero-row throw here, unlike the update above: `mdm_canonical_writer_deactivate_physician`
      // matches only an `active` row, so 0 is the ordinary idempotent-redelivery answer.
      await deps.db.execute(
        sql`SELECT mdm_canonical_writer_deactivate_physician(${canonicalId}, ${JSON.stringify(provenance)}::jsonb) AS applied`,
      );
    },

    async emitCanonicalUpdated(event) {
      record.canonicalId = event.id;
      record.changedFields = event.changedFields;
      await deps.db.transaction(async (tx) => {
        await deps.outbox.publish(tx as unknown as DbClient, {
          eventName: "m40.canonical.updated",
          payload: {
            kind: event.kind,
            canonicalId: event.id,
            changedFields: [...event.changedFields],
            source: "m29_platform_sync",
            updatedAt: now().toISOString(),
          },
          organizationId: null,
          aggregateKind: "external_physician",
          aggregateId: event.id,
        });
      });
    },

    async tenantsToAlert(canonicalId) {
      // §4.7.2 names two populations: tenants whose OVERLAY marks the provider preferred, and tenants
      // with an ACTIVE PATIENT attached to them. Only the first is reachable from M40. The attachment
      // lives on `admission.attending_physician_id` — M6's table — and M6 already `dependsOn` M40, so an
      // M40→M6 read (direct or by seam) is a dependency CYCLE the fitness gate rejects. The correct home
      // for that half is the inverse direction: a consumer of `m40.canonical.deactivated` inside M6,
      // which is exactly why that event is catalogued. Until someone builds it, this alerts the overlay
      // population and the event carries the rest of the signal durably.
      const orgs = await deps.orgs.listActiveOrgs();
      const alerted: string[] = [];
      for (const org of orgs) {
        // One query per org because the overlay is under `app.org_id` RLS: there is no single statement
        // that legitimately spans tenants. Deactivations are rare (a handful per nightly run), so the
        // fan-out cost is real but bounded, and the alternative — a cross-tenant SECURITY DEFINER read —
        // would be an un-audited bypass of exactly the gate ADR-0010 exists to enforce.
        const rows = await withOrgContext(
          deps.db,
          { organizationId: org.organizationId, userId: "" },
          (tx) =>
            tx
              .select({ id: OVERLAY.id })
              .from(OVERLAY)
              .where(
                and(
                  eq(OVERLAY.organizationId, org.organizationId),
                  eq(OVERLAY.externalPhysicianId, canonicalId),
                  eq(OVERLAY.isPreferred, true),
                ),
              )
              .limit(1),
        );
        if (rows.length > 0) alerted.push(org.organizationId);
      }
      record.alertedOrganizationIds = alerted;
      return alerted;
    },

    async emitDeactivationAlert(orgId, canonicalId, npi) {
      await deps.alerts.emit(orgId, {
        eventType: "mdm.physician_deactivated",
        payload: {
          canonicalId,
          npi,
          kind: "physician",
          deepLink: "/mdm",
          message: "A physician record was deactivated by the NPPES source.",
        },
        severity: "warn",
        correlationId: `m40-nppes-deactivation:${canonicalId}`,
      });
    },

    async writeDeactivationObservedAudit(npi, reason) {
      // An NPPES deactivation for an NPI this platform has no canonical for. §4.7.2 says observe-only:
      // no row is created (D10 — a stand-alone sync never auto-creates a canonical), but the observation
      // is recorded, because "we were told and did nothing" must be reconstructable. Org-less, so it
      // goes through the migration-0187 platform audit writer rather than the request-scoped audit path.
      await deps.db.execute(sql`
        SELECT audit_writer_insert_platform_event(
          ${"mdm.nppes_deactivation_observed"}, ${"external_physician"}, ${null}::uuid,
          ${"success"}, ${"info"}, ${`m40-nppes-deactivation:${npi}`},
          ${JSON.stringify({ npi, reason, note: "no canonical exists for this NPI (§4.7.2 observe-only)" })}::jsonb,
          ${"compliance"}
        )
      `);
    },
  };

  return { ports, record };
}
