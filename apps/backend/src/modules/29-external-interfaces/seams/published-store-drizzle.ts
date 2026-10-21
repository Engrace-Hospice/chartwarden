// apps/backend/src/modules/29-external-interfaces/seams/published-store-drizzle.ts — M29-T08 (§4.4).
//
// The Drizzle-backed {@link M29PublishedSeamStore} the five §4.4 seams delegate to. Every ORG-SCOPED read
// opens `withOrgContext` so RLS scopes it to the CONSUMER's ambient org (HARD RULE 3 — the seam self-scopes,
// never trusts the org id it was handed as a cross-tenant selector); the platform-shared NPPES reads carry
// no org context (read-all under `wardenx_app`). Aggregate/metadata reads only — no credential ciphertext,
// no raw HL7 payload crosses a seam.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";

import type {
  FeedHealthSeamDTO,
  FeedSeamSummary,
  InboundProposalSeamDTO,
  LabObservationSeamDTO,
  M29PublishedSeamStore,
  NppesProviderSeamDTO,
} from "./published";

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function createDrizzleM29PublishedSeamStore(db: DbClient): M29PublishedSeamStore {
  const OBS = schema.labObservation;
  const OBS_VALUE = schema.labObservationValue;
  const PROPOSAL = schema.hl7InboundProposal;
  const FEED = schema.externalFeed;
  const HEALTH = schema.externalFeedHealth;
  const NPPES = schema.nppesProvider;

  const ctx = (organizationId: string) => ({ organizationId, userId: "" });

  const obsDto = async (
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    organizationId: string,
    row: typeof OBS.$inferSelect,
  ): Promise<LabObservationSeamDTO> => {
    const values = await tx
      .select()
      .from(OBS_VALUE)
      .where(
        and(eq(OBS_VALUE.observationId, row.id), eq(OBS_VALUE.organizationId, organizationId)),
      );
    return {
      id: row.id,
      organizationId: row.organizationId,
      patientId: row.patientId,
      orderId: row.orderId,
      loincCode: row.loincCode,
      loincDisplayText: row.loincDisplayText,
      observationDate: row.observationDate.toISOString(),
      resultStatus: row.resultStatus,
      abnormalSummary: row.abnormalSummary,
      values: values.map((v) => ({
        obxSetId: v.obxSetId,
        loincCode: v.loincCode,
        loincDisplayText: v.loincDisplayText,
        valueType: v.valueType,
        numericValue: num(v.numericValue),
        stringValue: v.stringValue,
        units: v.units,
        abnormalFlag: v.abnormalFlag,
        // F-171 (#248) — SUD redaction is applied uniformly across every OBX row of ONE observation at
        // ingest (D15/W-XI-14: the consent check is per-MESSAGE, not per-row — see `lab-attach-planner.ts`
        // `buildValueRows`), so the per-value flag is honestly the parent observation's own
        // `sud_redacted_at_ingest` column, never an invented per-row classifier.
        isSudClass: row.sudRedactedAtIngest,
      })),
    };
  };

  const feedSummary = (row: typeof FEED.$inferSelect): FeedSeamSummary => ({
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    displayName: row.displayName,
    status: row.status,
  });

  const nppesDto = (row: typeof NPPES.$inferSelect): NppesProviderSeamDTO => ({
    npi: row.npi,
    enumerationType: row.enumerationType,
    status: row.status,
    basic: row.basic,
    taxonomies: row.taxonomies,
  });

  return {
    async labObservationById(organizationId, patientId, observationId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(OBS)
          .where(
            and(
              eq(OBS.id, observationId),
              eq(OBS.organizationId, organizationId),
              eq(OBS.patientId, patientId),
            ),
          )
          .limit(1);
        return row ? await obsDto(tx, organizationId, row) : null;
      });
    },
    async labObservationByObservationId(organizationId, observationId) {
      // F-171 (#248) — the patientId-free lookup `LabObservationReader.getByObservationId` delegates to.
      // `lab_observation.id` is the app-generated PK; scoping on `(id, organizationId)` alone is already
      // unique — no `patientId` predicate is needed to disambiguate the row, only to satisfy `getById`'s
      // extra defense-in-depth for the caller (M28) that already has one in hand.
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(OBS)
          .where(and(eq(OBS.id, observationId), eq(OBS.organizationId, organizationId)))
          .limit(1);
        return row ? await obsDto(tx, organizationId, row) : null;
      });
    },
    async labObservationsForPatient(organizationId, patientId, limit) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(OBS)
          .where(and(eq(OBS.organizationId, organizationId), eq(OBS.patientId, patientId)))
          .orderBy(desc(OBS.observationDate))
          .limit(limit);
        return Promise.all(rows.map((r) => obsDto(tx, organizationId, r)));
      });
    },
    async proposalsForPatient(organizationId, patientId, ownerModule, status) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(PROPOSAL)
          .where(
            and(
              eq(PROPOSAL.organizationId, organizationId),
              eq(PROPOSAL.matchedPatientId, patientId),
              eq(PROPOSAL.ownerModule, ownerModule),
            ),
          )
          .orderBy(desc(PROPOSAL.proposedAt));
        return rows
          .filter((r) => (status ? r.proposalStatus === status : true))
          .map(
            (r): InboundProposalSeamDTO => ({
              id: r.id,
              organizationId: r.organizationId,
              ownerModule: r.ownerModule,
              resourceKind: r.resourceKind,
              matchedPatientId: r.matchedPatientId,
              proposalStatus: r.proposalStatus,
              proposedAt: r.proposedAt.toISOString(),
            }),
          );
      });
    },
    async pendingProposalCounts(organizationId) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select({ ownerModule: PROPOSAL.ownerModule })
          .from(PROPOSAL)
          .where(
            and(
              eq(PROPOSAL.organizationId, organizationId),
              eq(PROPOSAL.proposalStatus, "pending"),
            ),
          );
        return {
          m5: rows.filter((r) => r.ownerModule === "m5").length,
          m6: rows.filter((r) => r.ownerModule === "m6").length,
        };
      });
    },
    async feedsForOrganization(organizationId, kind, status) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select()
          .from(FEED)
          .where(eq(FEED.organizationId, organizationId))
          .orderBy(desc(FEED.createdAt));
        return rows
          .filter((r) => (kind ? r.kind === kind : true))
          .filter((r) => (status ? r.status === status : true))
          .map(feedSummary);
      });
    },
    async feedHealth(organizationId, feedId) {
      return withOrgContext(
        db,
        ctx(organizationId),
        async (tx): Promise<FeedHealthSeamDTO | null> => {
          const [row] = await tx
            .select()
            .from(HEALTH)
            .where(and(eq(HEALTH.feedId, feedId), eq(HEALTH.organizationId, organizationId)))
            .orderBy(desc(HEALTH.hourBucket))
            .limit(1);
          if (!row) return null;
          return {
            feedId: row.feedId,
            hourBucket: row.hourBucket.toISOString(),
            listenerUpSeconds: row.listenerUpSeconds,
            listenerDownSeconds: row.listenerDownSeconds,
            inboundMessageCount: row.inboundMessageCount,
            outboundMessageCount: row.outboundMessageCount,
          };
        },
      );
    },
    async feedMessageCounts(organizationId, periodStart, periodEnd) {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        const rows = await tx
          .select({
            inbound: HEALTH.inboundMessageCount,
            outbound: HEALTH.outboundMessageCount,
          })
          .from(HEALTH)
          .where(
            and(
              eq(HEALTH.organizationId, organizationId),
              gte(HEALTH.hourBucket, new Date(periodStart)),
              lte(HEALTH.hourBucket, new Date(periodEnd)),
            ),
          );
        return {
          inbound: rows.reduce((s, r) => s + r.inbound, 0),
          outbound: rows.reduce((s, r) => s + r.outbound, 0),
        };
      });
    },
    async nppesByNpi(npi) {
      const [row] = await db.select().from(NPPES).where(eq(NPPES.npi, npi)).limit(1);
      return row ? nppesDto(row) : null;
    },
    async nppesByNpis(npis) {
      const result = new Map<string, NppesProviderSeamDTO | null>();
      for (const npi of npis) result.set(npi, null);
      if (npis.length === 0) return result;
      const rows = await db
        .select()
        .from(NPPES)
        .where(inArray(NPPES.npi, [...npis]));
      for (const row of rows) result.set(row.npi, nppesDto(row));
      return result;
    },
  };
}
