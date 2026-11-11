import { createHash } from "node:crypto";
import { resolveActorPermissions } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import {
  decodeKeysetCursor,
  encodeCursor,
  requireIdempotencyKey,
} from "@chartwarden/shared/route-kit";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { writeActorOf } from "./actor";
import { P } from "./guards";

export type BillingInvestigationModule = "M23" | "M41";
export type BillingInvestigationStatus =
  | "open"
  | "investigating"
  | "waiting_external"
  | "resolved"
  | "closed";
export type BillingResolutionOutcome =
  | "verified_no_action_required"
  | "referred_to_source_workflow"
  | "waiting_for_external_confirmation"
  | "duplicate_investigation"
  | "unable_to_resolve";

export interface BillingInvestigationSource {
  readonly sourceModule: BillingInvestigationModule;
  readonly submissionId: string;
  readonly claimId: string;
  readonly providerEntityId: string;
  readonly attempt: number;
  readonly reference: string;
  readonly payer: string;
  readonly reasonCode: string | null;
  readonly occurredAt: string;
  readonly currentStatus: string;
  readonly sourceHref: string;
}

export interface BillingInvestigationActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly providerEntityScope?: readonly string[];
}

export interface BillingInvestigationSourceReader {
  read(
    actor: BillingInvestigationActor,
    module: BillingInvestigationModule,
    submissionId: string,
  ): Promise<BillingInvestigationSource>;
}

export interface BillingInvestigationPorts {
  readonly sourceReader: BillingInvestigationSourceReader;
  readonly eligibleInvestigators: (
    organizationId: string,
    providerEntityId: string,
    sourceModule: BillingInvestigationModule,
  ) => Promise<readonly { membershipId: string; displayName: string }[]>;
  readonly investigatorEligible: (
    actor: BillingInvestigationActor,
    membershipId: string,
    source: BillingInvestigationSource,
  ) => Promise<boolean>;
  readonly now?: () => Date;
}

export const BillingOperationsInvestigationSourceSchema = Type.Object(
  {
    sourceModule: Type.Union([Type.Literal("M23"), Type.Literal("M41")]),
    submissionId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export const BillingOperationsInvestigationIdParamsSchema = Type.Object(
  { id: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
export const BillingOperationsInvestigationListQuerySchema = Type.Object(
  {
    providerEntityId: Type.Optional(Type.String({ format: "uuid" })),
    status: Type.Optional(
      Type.Union([
        Type.Literal("open"),
        Type.Literal("investigating"),
        Type.Literal("waiting_external"),
        Type.Literal("resolved"),
        Type.Literal("closed"),
      ]),
    ),
    assigned: Type.Optional(Type.Union([Type.Literal("me"), Type.Literal("unassigned")])),
    cursor: Type.Optional(Type.String({ maxLength: 1024 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);
export const BillingOperationsInvestigationAssignmentSchema = Type.Object(
  {
    assignedToMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 3, maxLength: 500 }),
  },
  { additionalProperties: false },
);
export const BillingOperationsInvestigationNoteSchema = Type.Object(
  { body: Type.String({ minLength: 1, maxLength: 2000 }) },
  { additionalProperties: false },
);
export const BillingOperationsInvestigationTransitionSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("investigating"),
      Type.Literal("waiting_external"),
      Type.Literal("resolved"),
      Type.Literal("closed"),
    ]),
    version: Type.Integer({ minimum: 1 }),
    reason: Type.String({ minLength: 3, maxLength: 500 }),
    outcome: Type.Optional(
      Type.Union([
        Type.Literal("verified_no_action_required"),
        Type.Literal("referred_to_source_workflow"),
        Type.Literal("waiting_for_external_confirmation"),
        Type.Literal("duplicate_investigation"),
        Type.Literal("unable_to_resolve"),
      ]),
    ),
  },
  { additionalProperties: false },
);
export const BillingOperationsInvestigatorQuerySchema = Type.Object(
  {
    providerEntityId: Type.String({ format: "uuid" }),
    sourceModule: Type.Union([Type.Literal("M23"), Type.Literal("M41")]),
    submissionId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);
export const BillingOperationsInvestigatorsSchema = Type.Object({
  items: Type.Array(
    Type.Object({
      membershipId: Type.String({ format: "uuid" }),
      displayName: Type.String(),
    }),
  ),
});
export const BillingOperationsInvestigationSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    organizationId: Type.String({ format: "uuid" }),
    providerEntityId: Type.String({ format: "uuid" }),
    sourceModule: Type.Union([Type.Literal("M23"), Type.Literal("M41")]),
    sourceRecordId: Type.String({ format: "uuid" }),
    sourceAttemptId: Type.String({ format: "uuid" }),
    sourceIdentity: Type.String(),
    sourceReasonCode: Type.Union([Type.String(), Type.Null()]),
    sourceOccurredAt: Type.String({ format: "date-time" }),
    status: Type.Union([
      Type.Literal("open"),
      Type.Literal("investigating"),
      Type.Literal("waiting_external"),
      Type.Literal("resolved"),
      Type.Literal("closed"),
    ]),
    resolutionOutcome: Type.Union([Type.String(), Type.Null()]),
    assignedToMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    createdByMembershipId: Type.String({ format: "uuid" }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    closedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    version: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export const BillingOperationsInvestigationListSchema = Type.Object({
  items: Type.Array(BillingOperationsInvestigationSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
  count: Type.Object({ kind: Type.Literal("lower_bound"), value: Type.Integer({ minimum: 0 }) }),
  countScope: Type.Literal("authorized loaded cases"),
});
export const BillingOperationsInvestigationDetailSchema = Type.Object({
  investigation: BillingOperationsInvestigationSchema,
  source: Type.Object({
    sourceModule: Type.Union([Type.Literal("M23"), Type.Literal("M41")]),
    submissionId: Type.String({ format: "uuid" }),
    claimId: Type.String({ format: "uuid" }),
    providerEntityId: Type.String({ format: "uuid" }),
    attempt: Type.Integer({ minimum: 0 }),
    reference: Type.String(),
    payer: Type.String(),
    reasonCode: Type.Union([Type.String(), Type.Null()]),
    occurredAt: Type.String({ format: "date-time" }),
    currentStatus: Type.String(),
    sourceHref: Type.String(),
  }),
  history: Type.Array(
    Type.Object({
      event_type: Type.String(),
      actor_membership_id: Type.String({ format: "uuid" }),
      previous_status: Type.Union([Type.String(), Type.Null()]),
      new_status: Type.Union([Type.String(), Type.Null()]),
      from_assignee_membership_id: Type.Union([Type.String(), Type.Null()]),
      to_assignee_membership_id: Type.Union([Type.String(), Type.Null()]),
      reason: Type.Union([Type.String(), Type.Null()]),
      correlation_id: Type.Union([Type.String(), Type.Null()]),
      occurredAt: Type.String({ format: "date-time" }),
    }),
  ),
  notes: Type.Array(
    Type.Object({
      id: Type.String({ format: "uuid" }),
      authorMembershipId: Type.String({ format: "uuid" }),
      body: Type.String(),
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
});
export const BillingOperationsInvestigationNoteResultSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  authorMembershipId: Type.String({ format: "uuid" }),
  body: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
});

const READ = P("billing.operations.read");
const TRIAGE = P("billing.operations.triage");
const ASSIGN = P("billing.operations.assign");
const IDEMPOTENT = requireIdempotencyKey();
const keyOf = (request: { headers: Record<string, string | string[] | undefined> }) => {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || value.length > 128)
    throw new ValidationError("A valid Idempotency-Key is required", []);
  return value;
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const providerAllowed = (actor: BillingInvestigationActor, providerEntityId: string) =>
  actor.providerEntityScope === undefined || actor.providerEntityScope.includes(providerEntityId);
const providerScopePredicate = (scope: readonly string[] | undefined) => {
  if (scope === undefined) return sql`true`;
  if (scope.length === 0) return sql`false`;
  return sql`provider_entity_id IN (${sql.join(
    scope.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
};

type DbRow = Record<string, unknown>;
const rowsOf = (result: unknown): DbRow[] => {
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as DbRow[]) : [];
};
const text = (row: DbRow, key: string): string => String(row[key]);
const nullable = (row: DbRow, key: string): string | null =>
  row[key] == null ? null : String(row[key]);
const view = (row: DbRow) => ({
  id: text(row, "id"),
  organizationId: text(row, "organization_id"),
  providerEntityId: text(row, "provider_entity_id"),
  sourceModule: text(row, "source_module") as BillingInvestigationModule,
  sourceRecordId: text(row, "source_record_id"),
  sourceAttemptId: text(row, "source_attempt_id"),
  sourceIdentity: text(row, "source_identity"),
  sourceReasonCode: nullable(row, "source_reason_code"),
  sourceOccurredAt: new Date(String(row.source_occurred_at)).toISOString(),
  status: text(row, "status") as BillingInvestigationStatus,
  resolutionOutcome: nullable(row, "resolution_outcome") as BillingResolutionOutcome | null,
  assignedToMembershipId: nullable(row, "assigned_to_membership_id"),
  createdByMembershipId: text(row, "created_by_membership_id"),
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
  closedAt: row.closed_at == null ? null : new Date(String(row.closed_at)).toISOString(),
  version: Number(row.version),
});

export class BillingOperationsInvestigationService {
  constructor(
    private readonly db: DbClient,
    private readonly ports: BillingInvestigationPorts,
  ) {}

  private async source(
    actor: BillingInvestigationActor,
    module: BillingInvestigationModule,
    submissionId: string,
  ) {
    const source = await this.ports.sourceReader.read(actor, module, submissionId);
    if (
      source.sourceModule !== module ||
      source.submissionId !== submissionId ||
      !providerAllowed(actor, source.providerEntityId)
    )
      throw new NotFoundError("billing source record not found");
    return source;
  }

  private async case(actor: BillingInvestigationActor, id: string) {
    const row = await withOrgContext(
      this.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) =>
        rowsOf(
          await tx.execute(
            sql`SELECT * FROM billing_operations_investigation WHERE organization_id = ${actor.organizationId}::uuid AND id = ${id}::uuid AND (${providerScopePredicate(actor.providerEntityScope)}) LIMIT 1`,
          ),
        )[0],
    );
    if (!row) throw new NotFoundError("billing investigation not found");
    const result = view(row);
    const source = await this.source(actor, result.sourceModule, result.sourceAttemptId);
    if (
      source.claimId !== result.sourceRecordId ||
      source.providerEntityId !== result.providerEntityId
    ) {
      throw new NotFoundError("billing investigation source association not found");
    }
    return result;
  }

  async list(
    actor: BillingInvestigationActor,
    filter: {
      providerEntityId?: string;
      status?: BillingInvestigationStatus;
      assigned?: "me" | "unassigned";
      cursor?: string;
      limit?: number;
    },
  ) {
    if (filter.providerEntityId && !providerAllowed(actor, filter.providerEntityId))
      throw new NotFoundError("billing investigation provider not found");
    return withOrgContext(
      this.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => {
        const after = decodeKeysetCursor(actor.organizationId, filter.cursor, "instant");
        const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
        const rows = rowsOf(
          await tx.execute(
            sql`SELECT *, updated_at::text AS sort_ts FROM billing_operations_investigation WHERE organization_id = ${actor.organizationId}::uuid AND (${filter.providerEntityId ? sql`provider_entity_id = ${filter.providerEntityId}::uuid` : sql`true`}) AND (${providerScopePredicate(actor.providerEntityScope)}) AND (${filter.status ? sql`status = ${filter.status}` : sql`true`}) AND (${filter.assigned === "me" ? sql`assigned_to_membership_id = ${actor.membershipId}::uuid` : filter.assigned === "unassigned" ? sql`assigned_to_membership_id IS NULL` : sql`true`}) AND (${after ? sql`(updated_at, id) < (${after.a}::timestamptz, ${after.id}::uuid)` : sql`true`}) ORDER BY updated_at DESC, id DESC LIMIT ${limit + 1}`,
          ),
        );
        const hasMore = rows.length > limit;
        const selected = hasMore ? rows.slice(0, limit) : rows;
        const authorized = await Promise.all(
          rows.map(async (row) => {
            const item = view(row);
            try {
              await this.source(actor, item.sourceModule, item.sourceAttemptId);
              return item;
            } catch (error) {
              if (error instanceof NotFoundError) return null;
              throw error;
            }
          }),
        );
        const items = authorized
          .slice(0, limit)
          .filter((item): item is ReturnType<typeof view> => item !== null);
        const last = selected.at(-1);
        return {
          items,
          hasMore,
          nextCursor:
            hasMore && last
              ? encodeCursor(actor.organizationId, { a: String(last.sort_ts), id: String(last.id) })
              : null,
          count: { kind: "lower_bound" as const, value: items.length },
          countScope: "authorized loaded cases" as const,
        };
      },
    );
  }

  async open(
    actor: BillingInvestigationActor,
    module: BillingInvestigationModule,
    submissionId: string,
    key: string,
  ) {
    const source = await this.source(actor, module, submissionId);
    const identity = `${module}:submission:${submissionId}`;
    return withOrgContext(
      this.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity + actor.organizationId}, 52))`,
        );
        const keyHash = digest(`open:${actor.organizationId}:${key}`);
        const fingerprint = digest(JSON.stringify({ module, submissionId }));
        const [priorRequest] = rowsOf(
          await tx.execute(
            sql`SELECT investigation_id, request_fingerprint FROM billing_operations_investigation_event WHERE organization_id = ${actor.organizationId}::uuid AND idempotency_key_hash = ${keyHash} LIMIT 1`,
          ),
        );
        if (priorRequest) {
          if (text(priorRequest, "request_fingerprint") !== fingerprint)
            throw new ConflictError("Idempotency-Key was reused for another investigation source");
          const [priorCase] = rowsOf(
            await tx.execute(
              sql`SELECT * FROM billing_operations_investigation WHERE organization_id = ${actor.organizationId}::uuid AND id = ${text(priorRequest, "investigation_id")}::uuid LIMIT 1`,
            ),
          );
          if (!priorCase) throw new NotFoundError("billing investigation not found");
          return view(priorCase);
        }
        if (source.currentStatus !== "in_doubt")
          throw new NotFoundError("in-doubt source submission not found");
        const inserted = rowsOf(
          await tx.execute(
            sql`INSERT INTO billing_operations_investigation (organization_id, provider_entity_id, source_module, source_record_id, source_attempt_id, source_identity, source_reason_code, source_occurred_at, created_by_membership_id) VALUES (${actor.organizationId}::uuid, ${source.providerEntityId}::uuid, ${module}, ${source.claimId}::uuid, ${source.submissionId}::uuid, ${identity}, ${source.reasonCode}, ${source.occurredAt}::timestamptz, ${actor.membershipId}::uuid) ON CONFLICT (organization_id, source_identity) DO NOTHING RETURNING *`,
          ),
        );
        const rows = inserted.length
          ? inserted
          : rowsOf(
              await tx.execute(
                sql`SELECT * FROM billing_operations_investigation WHERE organization_id = ${actor.organizationId}::uuid AND source_identity = ${identity} LIMIT 1`,
              ),
            );
        const row = rows[0];
        if (!row) throw new ConflictError("investigation could not be opened");
        const caseView = view(row);
        if (inserted.length)
          await tx.execute(
            sql`INSERT INTO billing_operations_investigation_event (organization_id, investigation_id, event_type, actor_membership_id, new_status, reason, idempotency_key_hash, request_fingerprint) VALUES (${actor.organizationId}::uuid, ${caseView.id}::uuid, 'created', ${actor.membershipId}::uuid, 'open', 'Investigation opened for an authorized source submission', ${keyHash}, ${fingerprint})`,
          );
        return caseView;
      },
    );
  }

  async detail(actor: BillingInvestigationActor, id: string) {
    const investigation = await this.case(actor, id);
    const source = await this.source(
      actor,
      investigation.sourceModule,
      investigation.sourceAttemptId,
    );
    const [history, notes] = await withOrgContext(
      this.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) =>
        Promise.all([
          tx.execute(
            sql`SELECT event_type, actor_membership_id, previous_status, new_status, from_assignee_membership_id, to_assignee_membership_id, reason, correlation_id, occurred_at FROM billing_operations_investigation_event WHERE organization_id = ${actor.organizationId}::uuid AND investigation_id = ${id}::uuid ORDER BY occurred_at, id`,
          ),
          tx.execute(
            sql`SELECT id, author_membership_id, body, created_at FROM billing_operations_investigation_note WHERE organization_id = ${actor.organizationId}::uuid AND investigation_id = ${id}::uuid ORDER BY created_at, id`,
          ),
        ]),
    );
    return {
      investigation,
      source,
      history: rowsOf(history).map((r) => ({
        ...r,
        occurredAt: new Date(String(r.occurred_at)).toISOString(),
      })),
      notes: rowsOf(notes).map((r) => ({
        id: text(r, "id"),
        authorMembershipId: text(r, "author_membership_id"),
        body: text(r, "body"),
        createdAt: new Date(String(r.created_at)).toISOString(),
      })),
    };
  }

  async investigators(
    actor: BillingInvestigationActor,
    providerEntityId: string,
    sourceModule: BillingInvestigationModule,
    submissionId: string,
  ) {
    if (!providerAllowed(actor, providerEntityId))
      throw new NotFoundError("billing investigation provider not found");
    const source = await this.source(actor, sourceModule, submissionId);
    if (source.providerEntityId !== providerEntityId)
      throw new NotFoundError("billing investigation provider not found");
    const candidates = await this.ports.eligibleInvestigators(
      actor.organizationId,
      providerEntityId,
      sourceModule,
    );
    const results = await Promise.all(
      candidates.map(async (candidate) =>
        (await this.ports.investigatorEligible(actor, candidate.membershipId, source))
          ? candidate
          : null,
      ),
    );
    return results.filter(
      (candidate): candidate is NonNullable<typeof candidate> => candidate !== null,
    );
  }

  async assign(
    actor: BillingInvestigationActor,
    id: string,
    assignedTo: string | null,
    version: number,
    reason: string,
    key: string,
  ) {
    const item = await this.case(actor, id);
    const source = await this.source(actor, item.sourceModule, item.sourceAttemptId);
    if (assignedTo && !(await this.ports.investigatorEligible(actor, assignedTo, source)))
      throw new NotFoundError("eligible investigator not found");
    return withOrgContext(
      this.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => {
        const keyHash = digest(`assign:${key}`);
        const fingerprint = digest(
          JSON.stringify({ id, assignedTo, version, reason: reason.trim() }),
        );
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 81))`);
        const [prior] = rowsOf(
          await tx.execute(
            sql`SELECT request_fingerprint FROM billing_operations_investigation_event WHERE organization_id = ${actor.organizationId}::uuid AND idempotency_key_hash = ${keyHash} LIMIT 1`,
          ),
        );
        if (prior) {
          if (text(prior, "request_fingerprint") !== fingerprint)
            throw new ConflictError("Idempotency-Key was reused with different assignment details");
          const [current] = rowsOf(
            await tx.execute(
              sql`SELECT * FROM billing_operations_investigation WHERE organization_id = ${actor.organizationId}::uuid AND id = ${id}::uuid`,
            ),
          );
          if (!current) throw new NotFoundError("billing investigation not found");
          return view(current);
        }
        const rows = rowsOf(
          await tx.execute(
            sql`UPDATE billing_operations_investigation SET assigned_to_membership_id = ${assignedTo}::uuid, updated_at = now(), version = version + 1 WHERE organization_id = ${actor.organizationId}::uuid AND id = ${id}::uuid AND provider_entity_id = ${item.providerEntityId}::uuid AND version = ${version} RETURNING *`,
          ),
        );
        const row = rows[0];
        if (!row) throw new ConflictError("investigation changed; refresh and try again");
        const updated = view(row);
        await tx.execute(
          sql`INSERT INTO billing_operations_investigation_event (organization_id, investigation_id, event_type, actor_membership_id, from_assignee_membership_id, to_assignee_membership_id, reason, idempotency_key_hash, request_fingerprint) VALUES (${actor.organizationId}::uuid, ${id}::uuid, ${assignedTo ? "assigned" : "unassigned"}, ${actor.membershipId}::uuid, ${item.assignedToMembershipId}::uuid, ${assignedTo}::uuid, ${reason.trim()}, ${keyHash}, ${fingerprint})`,
        );
        return updated;
      },
    );
  }

  async addNote(actor: BillingInvestigationActor, id: string, body: string, key: string) {
    await this.case(actor, id);
    const clean = body.trim();
    if (!clean || clean.length > 2000)
      throw new ValidationError("Note must contain 1 to 2,000 characters", []);
    return withOrgContext(
      this.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => {
        const keyHash = digest(`note:${key}`);
        const fingerprint = digest(JSON.stringify({ id, body: clean }));
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 82))`);
        const [prior] = rowsOf(
          await tx.execute(
            sql`SELECT id, author_membership_id, body, created_at, request_fingerprint FROM billing_operations_investigation_note WHERE organization_id = ${actor.organizationId}::uuid AND idempotency_key_hash = ${keyHash} LIMIT 1`,
          ),
        );
        if (prior) {
          if (text(prior, "request_fingerprint") !== fingerprint)
            throw new ConflictError("Idempotency-Key was reused with different note text");
          return {
            id: text(prior, "id"),
            authorMembershipId: text(prior, "author_membership_id"),
            body: text(prior, "body"),
            createdAt: new Date(String(prior.created_at)).toISOString(),
          };
        }
        const [note] = rowsOf(
          await tx.execute(
            sql`INSERT INTO billing_operations_investigation_note (organization_id, investigation_id, author_membership_id, body, idempotency_key_hash, request_fingerprint) VALUES (${actor.organizationId}::uuid, ${id}::uuid, ${actor.membershipId}::uuid, ${clean}, ${keyHash}, ${fingerprint}) RETURNING id, author_membership_id, body, created_at`,
          ),
        );
        if (!note) {
          throw new ConflictError("investigation note was not recorded");
        }
        await tx.execute(
          sql`UPDATE billing_operations_investigation SET updated_at = now(), version = version + 1 WHERE organization_id = ${actor.organizationId}::uuid AND id = ${id}::uuid`,
        );
        await tx.execute(
          sql`INSERT INTO billing_operations_investigation_event (organization_id, investigation_id, event_type, actor_membership_id, reason, idempotency_key_hash, request_fingerprint) VALUES (${actor.organizationId}::uuid, ${id}::uuid, 'note_added', ${actor.membershipId}::uuid, 'Investigation note added', ${digest(`note-event:${key}`)}, ${fingerprint}) ON CONFLICT (organization_id, idempotency_key_hash) DO NOTHING`,
        );
        return {
          id: text(note, "id"),
          authorMembershipId: text(note, "author_membership_id"),
          body: text(note, "body"),
          createdAt: new Date(String(note.created_at)).toISOString(),
        };
      },
    );
  }

  async transition(
    actor: BillingInvestigationActor,
    id: string,
    next: BillingInvestigationStatus,
    version: number,
    reason: string,
    outcome: BillingResolutionOutcome | undefined,
    key: string,
  ) {
    const item = await this.case(actor, id);
    const allowed: Record<BillingInvestigationStatus, readonly BillingInvestigationStatus[]> = {
      open: ["investigating"],
      investigating: ["waiting_external", "resolved"],
      waiting_external: ["investigating", "resolved"],
      resolved: ["closed", "investigating"],
      closed: ["investigating"],
    };
    if (!allowed[item.status].includes(next))
      throw new ValidationError(`Invalid investigation transition ${item.status} → ${next}`, []);
    if ((next === "resolved") !== Boolean(outcome))
      throw new ValidationError(
        "Resolution outcome is required only when resolving an investigation",
        [],
      );
    if (reason.trim().length < 3)
      throw new ValidationError("A reason of at least 3 characters is required", []);
    return withOrgContext(
      this.db,
      { organizationId: actor.organizationId, userId: actor.userId },
      async (tx) => {
        const keyHash = digest(`transition:${key}`);
        const fingerprint = digest(
          JSON.stringify({ id, next, version, reason: reason.trim(), outcome: outcome ?? null }),
        );
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 83))`);
        const [prior] = rowsOf(
          await tx.execute(
            sql`SELECT request_fingerprint FROM billing_operations_investigation_event WHERE organization_id = ${actor.organizationId}::uuid AND idempotency_key_hash = ${keyHash} LIMIT 1`,
          ),
        );
        if (prior) {
          if (text(prior, "request_fingerprint") !== fingerprint)
            throw new ConflictError("Idempotency-Key was reused with different transition details");
          const [current] = rowsOf(
            await tx.execute(
              sql`SELECT * FROM billing_operations_investigation WHERE organization_id = ${actor.organizationId}::uuid AND id = ${id}::uuid`,
            ),
          );
          if (!current) throw new NotFoundError("billing investigation not found");
          return view(current);
        }
        const rows = rowsOf(
          await tx.execute(
            sql`UPDATE billing_operations_investigation SET status = ${next}, resolution_outcome = CASE WHEN ${next} = 'resolved' THEN ${outcome ?? null} WHEN ${next} = 'closed' THEN ${item.resolutionOutcome} ELSE NULL END, closed_at = ${next === "closed" ? new Date().toISOString() : null}::timestamptz, updated_at = now(), version = version + 1 WHERE organization_id = ${actor.organizationId}::uuid AND id = ${id}::uuid AND version = ${version} RETURNING *`,
          ),
        );
        const row = rows[0];
        if (!row) throw new ConflictError("investigation changed; refresh and try again");
        await tx.execute(
          sql`INSERT INTO billing_operations_investigation_event (organization_id, investigation_id, event_type, actor_membership_id, previous_status, new_status, reason, idempotency_key_hash, request_fingerprint) VALUES (${actor.organizationId}::uuid, ${id}::uuid, ${next === "resolved" ? "resolved" : item.status === "closed" || item.status === "resolved" ? "reopened" : "status_changed"}, ${actor.membershipId}::uuid, ${item.status}, ${next}, ${reason.trim()}, ${keyHash}, ${fingerprint})`,
        );
        return view(row);
      },
    );
  }
}

export function registerBillingOperationsInvestigationRoutes(
  app: FastifyInstance,
  service: BillingOperationsInvestigationService,
): void {
  app.get(
    "/api/v1/billing/operations/investigations",
    {
      preHandler: [READ],
      schema: {
        querystring: BillingOperationsInvestigationListQuerySchema,
        response: { 200: BillingOperationsInvestigationListSchema },
      },
      config: { auditRead: { resourceKind: "billing_operations_investigation", list: true } },
    },
    async (request) => {
      const q = request.query as {
        providerEntityId?: string;
        status?: BillingInvestigationStatus;
        assigned?: "me" | "unassigned";
        cursor?: string;
        limit?: number;
      };
      return service.list(writeActorOf(request) as BillingInvestigationActor, q);
    },
  );
  app.get(
    "/api/v1/billing/operations/investigations/investigators",
    {
      preHandler: [ASSIGN],
      schema: {
        querystring: BillingOperationsInvestigatorQuerySchema,
        response: { 200: BillingOperationsInvestigatorsSchema },
      },
      config: { auditRead: { resourceKind: "billing_operations_investigation", list: true } },
    },
    async (request) => {
      const q = request.query as {
        providerEntityId?: string;
        sourceModule?: BillingInvestigationModule;
        submissionId?: string;
      };
      if (!q.providerEntityId || !q.sourceModule || !q.submissionId)
        throw new ValidationError(
          "providerEntityId, sourceModule and submissionId are required",
          [],
        );
      return {
        items: await service.investigators(
          writeActorOf(request) as BillingInvestigationActor,
          q.providerEntityId,
          q.sourceModule,
          q.submissionId,
        ),
      };
    },
  );
  app.post(
    "/api/v1/billing/operations/investigations",
    {
      preHandler: [TRIAGE, IDEMPOTENT],
      schema: {
        body: BillingOperationsInvestigationSourceSchema,
        response: { 201: BillingOperationsInvestigationSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        sourceModule: BillingInvestigationModule;
        submissionId: string;
      };
      return reply
        .code(201)
        .send(
          await service.open(
            writeActorOf(request) as BillingInvestigationActor,
            body.sourceModule,
            body.submissionId,
            keyOf(request),
          ),
        );
    },
  );
  app.get(
    "/api/v1/billing/operations/investigations/:id",
    {
      preHandler: [READ],
      schema: {
        params: BillingOperationsInvestigationIdParamsSchema,
        response: { 200: BillingOperationsInvestigationDetailSchema },
      },
      config: {
        auditRead: { resourceKind: "billing_operations_investigation", resourceIdParam: "id" },
      },
    },
    async (request) =>
      service.detail(
        writeActorOf(request) as BillingInvestigationActor,
        (request.params as { id: string }).id,
      ),
  );
  app.post(
    "/api/v1/billing/operations/investigations/:id/assignment",
    {
      preHandler: [ASSIGN, IDEMPOTENT],
      schema: {
        params: BillingOperationsInvestigationIdParamsSchema,
        body: BillingOperationsInvestigationAssignmentSchema,
        response: { 200: BillingOperationsInvestigationSchema },
      },
    },
    async (request) => {
      const body = request.body as {
        assignedToMembershipId: string | null;
        version: number;
        reason: string;
      };
      return service.assign(
        writeActorOf(request) as BillingInvestigationActor,
        (request.params as { id: string }).id,
        body.assignedToMembershipId,
        body.version,
        body.reason,
        keyOf(request),
      );
    },
  );
  app.post(
    "/api/v1/billing/operations/investigations/:id/notes",
    {
      preHandler: [TRIAGE, IDEMPOTENT],
      schema: {
        params: BillingOperationsInvestigationIdParamsSchema,
        body: BillingOperationsInvestigationNoteSchema,
        response: { 200: BillingOperationsInvestigationNoteResultSchema },
      },
    },
    async (request) =>
      service.addNote(
        writeActorOf(request) as BillingInvestigationActor,
        (request.params as { id: string }).id,
        (request.body as { body: string }).body,
        keyOf(request),
      ),
  );
  app.post(
    "/api/v1/billing/operations/investigations/:id/transitions",
    {
      preHandler: [TRIAGE, IDEMPOTENT],
      schema: {
        params: BillingOperationsInvestigationIdParamsSchema,
        body: BillingOperationsInvestigationTransitionSchema,
        response: { 200: BillingOperationsInvestigationSchema },
      },
    },
    async (request) => {
      const body = request.body as {
        status: BillingInvestigationStatus;
        version: number;
        reason: string;
        outcome?: BillingResolutionOutcome;
      };
      const actor = writeActorOf(request);
      const previousStatus = (
        await service.detail(
          actor as BillingInvestigationActor,
          (request.params as { id: string }).id,
        )
      ).investigation.status;
      if (
        body.status === "resolved" ||
        body.status === "closed" ||
        ((previousStatus === "resolved" || previousStatus === "closed") &&
          body.status === "investigating")
      ) {
        // Resolution/reopening is a separately granted operational capability; generic triage cannot close cases.
        const permissions = await resolveActorPermissions({
          organizationId: actor.organizationId,
          userId: actor.userId,
        });
        if (!permissions.has("billing.operations.resolve"))
          throw new ForbiddenError("Billing investigation resolution permission required");
      }
      return service.transition(
        actor as BillingInvestigationActor,
        (request.params as { id: string }).id,
        body.status,
        body.version,
        body.reason,
        body.outcome,
        keyOf(request),
      );
    },
  );
}
