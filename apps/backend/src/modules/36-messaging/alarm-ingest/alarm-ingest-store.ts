// M36 WP 6.10 (ADR-0102, PROPOSED) - the storage port of alarm ingest and its Drizzle implementation. The service holds every rule; this is only
// reads and writes inside ONE tenant transaction each. The inbound route has no user: it runs as the system actor (audit rows say so) under
// the credential's own organisation, so RLS scopes every statement to that one tenant. Staff calls run as the staff member (the audit actor).
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type {
  AlarmIngestAlertType,
  AlarmIngestEventStatus,
  AlarmMappingInput,
  AlarmRequestedSeverity,
  AlarmSeverityCeiling,
  AlarmSourceCounts,
} from "@chartwarden/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

const S = schema.alarmSources;
const M = schema.alarmSourceMappings;
const E = schema.alarmIngestEvents;

export interface IngestMapping {
  readonly alertType: AlarmIngestAlertType;
  readonly severityCeiling: AlarmSeverityCeiling;
}

/** What one inbound request needs about its credential: the sealed secret, whether it is live, and its mappings by alarm kind. */
export interface IngestSource {
  readonly id: string;
  readonly enabled: boolean;
  readonly secretCipher: Buffer;
  readonly mappings: ReadonlyMap<string, IngestMapping>;
}

export interface NewEvent {
  readonly sourceId: string;
  readonly eventId: string;
  readonly payloadDigest: string;
  readonly alarmKind: string;
  readonly alertType: AlarmIngestAlertType | null;
  readonly requestedSeverity: AlarmRequestedSeverity | null;
  readonly effectiveSeverity: AlarmSeverityCeiling | null;
  readonly occurredAt: Date | null;
}

export interface EventRow {
  readonly id: string;
  readonly status: AlarmIngestEventStatus;
  readonly payloadDigest: string;
  readonly alertType: AlarmIngestAlertType | null;
  readonly effectiveSeverity: AlarmSeverityCeiling | null;
}

export interface SourceView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly secretGeneration: number;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
  readonly disabledAt: Date | null;
  readonly lastAcceptedAt: Date | null;
  readonly mappings: readonly AlarmMappingInput[];
  readonly last24h: AlarmSourceCounts;
}

export interface StaffActor {
  readonly organizationId: string;
  readonly userId: string;
}

export interface AlarmIngestStore {
  loadSource(organizationId: string, sourceId: string): Promise<IngestSource | null>;
  /** Insert the event, or return the one already stored for (source, event id): `created` says which. */
  recordEvent(
    organizationId: string,
    event: NewEvent,
  ): Promise<{ readonly row: EventRow; readonly created: boolean }>;
  /** received -> alerted | no_recipients, once. A second settle (a concurrent retry) is a no-op. */
  settleEvent(
    organizationId: string,
    id: string,
    outcome: "alerted" | "no_recipients",
    alertId: string,
    recipientCount: number,
  ): Promise<void>;
  /** Enabled sources in the tenant; the cap check runs under the same tenant lock as the insert. */
  createSource(
    actor: StaffActor,
    input: {
      readonly name: string;
      readonly secretCipher: Buffer;
      readonly mappings: readonly AlarmMappingInput[];
      readonly maxSources: number;
    },
  ): Promise<SourceView | "cap_reached">;
  listSources(actor: StaffActor): Promise<SourceView[]>;
  /** Null when the source is unknown or already disabled. */
  rotateSource(actor: StaffActor, id: string, secretCipher: Buffer): Promise<SourceView | null>;
  /** Null when the source is unknown. An already-disabled source is returned unchanged (idempotent). */
  disableSource(actor: StaffActor, id: string): Promise<SourceView | null>;
}

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

const ZERO_COUNTS: AlarmSourceCounts = { alerted: 0, noRecipients: 0, unmapped: 0, pending: 0 };

async function viewsOf(
  tx: Tx,
  organizationId: string,
  where: ReturnType<typeof eq> | ReturnType<typeof and>,
): Promise<SourceView[]> {
  const sources = await tx.select().from(S).where(where).orderBy(asc(S.createdAt), asc(S.id));
  if (sources.length === 0) return [];
  const ids = sources.map((s) => s.id);
  const mappings = await tx
    .select()
    .from(M)
    .where(and(eq(M.organizationId, organizationId), inArray(M.sourceId, ids)))
    .orderBy(asc(M.alarmKind));
  const counts = await tx
    .select({ sourceId: E.sourceId, status: E.status, n: sql<number>`count(*)::int` })
    .from(E)
    .where(
      and(
        eq(E.organizationId, organizationId),
        inArray(E.sourceId, ids),
        sql`${E.createdAt} > now() - interval '24 hours'`,
      ),
    )
    .groupBy(E.sourceId, E.status);
  const lasts = await tx
    .select({ sourceId: E.sourceId, at: sql<string>`max(${E.createdAt})` })
    .from(E)
    .where(
      and(
        eq(E.organizationId, organizationId),
        inArray(E.sourceId, ids),
        inArray(E.status, ["received", "alerted", "no_recipients"]),
      ),
    )
    .groupBy(E.sourceId);
  return sources.map((s) => {
    const c = { ...ZERO_COUNTS };
    const mine = new Map(counts.filter((r) => r.sourceId === s.id).map((r) => [r.status, r.n]));
    const last = lasts.find((l) => l.sourceId === s.id);
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      secretGeneration: s.secretGeneration,
      createdAt: s.createdAt,
      rotatedAt: s.rotatedAt,
      disabledAt: s.disabledAt,
      lastAcceptedAt: last?.at ? new Date(last.at) : null,
      mappings: mappings
        .filter((m) => m.sourceId === s.id)
        .map((m) => ({
          alarmKind: m.alarmKind,
          alertType: m.alertType as AlarmIngestAlertType,
          severityCeiling: m.severityCeiling as AlarmSeverityCeiling,
        })),
      last24h: {
        ...c,
        alerted: mine.get("alerted") ?? 0,
        noRecipients: mine.get("no_recipients") ?? 0,
        unmapped: mine.get("unmapped") ?? 0,
        pending: mine.get("received") ?? 0,
      },
    };
  });
}

function toEventRow(r: typeof E.$inferSelect): EventRow {
  return {
    id: r.id,
    status: r.status as AlarmIngestEventStatus,
    payloadDigest: r.payloadDigest,
    alertType: r.alertType as AlarmIngestAlertType | null,
    effectiveSeverity: r.effectiveSeverity as AlarmSeverityCeiling | null,
  };
}

export function createDrizzleAlarmIngestStore(db: DbClient): AlarmIngestStore {
  const staff = <T>(actor: StaffActor, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: actor.organizationId, userId: actor.userId }, fn);
  const sourceById = async (tx: Tx, orgId: string, id: string): Promise<SourceView | null> =>
    (await viewsOf(tx, orgId, and(eq(S.organizationId, orgId), eq(S.id, id))))[0] ?? null;

  return {
    loadSource: (organizationId, sourceId) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
        const [row] = await tx
          .select()
          .from(S)
          .where(and(eq(S.organizationId, organizationId), eq(S.id, sourceId)))
          .limit(1);
        if (!row) return null;
        const rows = await tx
          .select()
          .from(M)
          .where(and(eq(M.organizationId, organizationId), eq(M.sourceId, sourceId)));
        return {
          id: row.id,
          enabled: row.enabled,
          secretCipher: row.secretCipher,
          mappings: new Map(
            rows.map((m) => [
              m.alarmKind,
              {
                alertType: m.alertType as AlarmIngestAlertType,
                severityCeiling: m.severityCeiling as AlarmSeverityCeiling,
              },
            ]),
          ),
        };
      }),

    recordEvent: (organizationId, event) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
        const [inserted] = await tx
          .insert(E)
          .values({
            organizationId,
            sourceId: event.sourceId,
            eventId: event.eventId,
            payloadDigest: event.payloadDigest,
            alarmKind: event.alarmKind,
            alertType: event.alertType,
            requestedSeverity: event.requestedSeverity,
            effectiveSeverity: event.effectiveSeverity,
            occurredAt: event.occurredAt,
            status: event.alertType === null ? "unmapped" : "received",
          })
          .onConflictDoNothing({ target: [E.organizationId, E.sourceId, E.eventId] })
          .returning();
        if (inserted) return { row: toEventRow(inserted), created: true };
        const [existing] = await tx
          .select()
          .from(E)
          .where(
            and(
              eq(E.organizationId, organizationId),
              eq(E.sourceId, event.sourceId),
              eq(E.eventId, event.eventId),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("alarm ingest event vanished after a conflict");
        return { row: toEventRow(existing), created: false };
      }),

    settleEvent: (organizationId, id, outcome, alertId, recipientCount) =>
      withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
        await tx
          .update(E)
          .set({ status: outcome, alertId, recipientCount })
          .where(
            and(eq(E.organizationId, organizationId), eq(E.id, id), eq(E.status, "received")),
          );
      }),

    createSource: (actor, input) =>
      staff(actor, async (tx) => {
        const orgId = actor.organizationId;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`alarm-source:${orgId}`}, 62))`,
        );
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(S)
          .where(and(eq(S.organizationId, orgId), eq(S.enabled, true)));
        if (Number(count?.n ?? 0) >= input.maxSources) return "cap_reached" as const;
        const [created] = await tx
          .insert(S)
          .values({
            organizationId: orgId,
            name: input.name,
            secretCipher: input.secretCipher,
            createdBy: actor.userId,
          })
          .returning({ id: S.id });
        if (!created) throw new Error("alarm source insert returned no row");
        await tx.insert(M).values(
          input.mappings.map((m) => ({
            organizationId: orgId,
            sourceId: created.id,
            alarmKind: m.alarmKind,
            alertType: m.alertType,
            severityCeiling: m.severityCeiling,
          })),
        );
        const view = await sourceById(tx, orgId, created.id);
        if (!view) throw new Error("alarm source vanished after insert");
        return view;
      }),

    listSources: (actor) =>
      staff(actor, (tx) =>
        viewsOf(tx, actor.organizationId, eq(S.organizationId, actor.organizationId)),
      ),

    rotateSource: (actor, id, secretCipher) =>
      staff(actor, async (tx) => {
        const orgId = actor.organizationId;
        const [current] = await tx
          .select({ generation: S.secretGeneration })
          .from(S)
          .where(and(eq(S.organizationId, orgId), eq(S.id, id), eq(S.enabled, true)))
          .for("update")
          .limit(1);
        if (!current) return null;
        await tx
          .update(S)
          .set({
            secretCipher,
            secretGeneration: current.generation + 1,
            rotatedBy: actor.userId,
          })
          .where(and(eq(S.organizationId, orgId), eq(S.id, id)));
        return sourceById(tx, orgId, id);
      }),

    disableSource: (actor, id) =>
      staff(actor, async (tx) => {
        const orgId = actor.organizationId;
        await tx
          .update(S)
          .set({ enabled: false, disabledBy: actor.userId })
          .where(and(eq(S.organizationId, orgId), eq(S.id, id), eq(S.enabled, true)));
        return sourceById(tx, orgId, id);
      }),
  };
}
