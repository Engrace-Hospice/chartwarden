// apps/backend/src/modules/16-bereavement/outbox-consumers/m22-document-rendered.ts — GAP-130, the §4.5
// `m22.document.rendered` → `handleDocumentRendered` binding (D14, §7.6): the downstream half of the M22
// render handshake for bereavement outreach artifacts.
//
// M16 §4.5: "`m22.document.rendered` (filtered to bereavement template_keys) | M22 | `handleDocumentRendered`
// | set `outreach.rendered_document_id`, `m22_rendered_at`; emit `m16.bereavement.outreach_completed` if
// kind ∈ {sympathy_card, anniversary_letter, sympathy_letter}". The upstream half is the
// `startContact` transition of a rendering kind (`lifecycle/outreach.ts`), which emits
// `outreach_artifact_requested` naming the OUTREACH; M22 files the document against that outreach id
// (`render-consumer.ts`'s M16 request shape) and answers with this event.
//
// ROUTING, FAIL-CLOSED: the dispatcher hands every rendered document in the tenant to every back-ref
// consumer, so anything that is not M16's own outreach request — another module's document, a foreign
// aggregate type, the plan-keyed welcome packet (filed against the PLAN at plan-open, before any outreach
// row exists, so there is no outreach column to stamp) — returns before a transaction opens. An
// `aggregateId` that resolves to no outreach in this org is likewise a no-op, never a guess.
//
// COMPLETION (§4.5, `AUTO_COMPLETE_ON_RENDER_KINDS`): for a card / sympathy letter / anniversary letter
// still `in_progress`, the render IS the touchpoint, so a `bereavement_contact_log` row (§2.4: completion
// requires one) is written with `artifact_document_id` and the system-only `artifact_rendered` outcome
// (mig 0492 — none of the ten survivor-response outcomes is true of a PDF nobody has read yet), attributed
// to the outreach's assignee, else the plan's counselor. An invitation or referral letter is stamped but
// left open (the family's response / the counselor's confirmation closes those), as is a row with no
// counselor to attribute the log to.
//
// IDEMPOTENT: the stamp is `WHERE rendered_document_id IS NULL`; a redelivery finds it set and writes
// nothing. The completion is guarded on the `in_progress` status it was decided from.
//
// ADR-0109 D6 / D9 — the SECOND request event M16 sends M22, `m16.bereavement.document_requested`, has two back-refs, both routed by the
// aggregate TYPE M22 filed the document under (never guessed): `bereavement_physician_letter` (aggregate = the letter) moves an
// `approved` letter to `rendered` and stamps `rendered_document_id` / `m22_rendered_at`; `bereavement_discharge_summary` (aggregate = the
// closure) stamps `bereavement_plan_closure.discharge_summary_document_id`. Both stamps are `WHERE ... IS NULL`, so a redelivery writes
// nothing; a row that is not in the state the render was requested from (a letter that is not `approved`) is left alone.
import { AUTO_COMPLETE_ON_RENDER_KINDS } from "@chartwarden/bereavement";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { BereavementOutreachKind, IsoInstant } from "@chartwarden/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import { transitionBereavementOutreach } from "../lifecycle/index";
import { runEffects } from "../routes/effects-runner";
import type { WriteOutboxPort } from "../routes/write-service";

const PLAN = schema.bereavementPlan;
const OUTREACH = schema.bereavementOutreach;
const LOG = schema.bereavementContactLog;
const LETTER = schema.bereavementPhysicianLetter;
const CLOSURE = schema.bereavementPlanClosure;

const CONSUMER_USER_ID = "";

/** The request event this consumer answers, and the module that emits it (M22's routing fields). */
const SOURCE_EVENT = "m16.bereavement.outreach_artifact_requested";
const SOURCE_MODULE = "m16";
/** M22's aggregate type for every bereavement letter template (`22-documents/seams/renderer.ts`). */
const BEREAVEMENT_LETTER_AGGREGATE_TYPE = "bereavement_letter";
/** ADR-0109 — the plan-level documents behind `m16.bereavement.document_requested`, and the aggregate types M22 files them under. */
const DOCUMENT_REQUESTED_EVENT = "m16.bereavement.document_requested";
const PHYSICIAN_LETTER_AGGREGATE_TYPE = "bereavement_physician_letter";
const DISCHARGE_SUMMARY_AGGREGATE_TYPE = "bereavement_discharge_summary";
/** The plan-open packet — filed against the PLAN, so it has no outreach back-ref. */
const WELCOME_PACKET_TEMPLATE_KEY = "bereavement_welcome_packet";
/** GAP-130 / mig 0492 — the system-only outcome of an auto-completed render. */
const RENDERED_OUTCOME = "artifact_rendered" as const;

export const M16_DOCUMENT_RENDERED_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m16.document-backref",
} as const;

export interface DocumentRenderedDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m16.*` against the boot catalog. */
  readonly outbox: WriteOutboxPort;
}

/** The outreach facts the back-ref decision reads. */
export interface RenderedBackrefFacts {
  readonly kind: string;
  readonly status: string;
  readonly renderedDocumentId: string | null;
  /** Who the completion's contact-log row is attributed to (assignee, else plan counselor), or null. */
  readonly loggerMembershipId: string | null;
}

/** Pure — whether to stamp the back-ref and whether the render completes the touchpoint (§4.5). */
export function decideRenderedBackref(facts: RenderedBackrefFacts): {
  readonly stamp: boolean;
  readonly complete: boolean;
} {
  if (facts.renderedDocumentId !== null) return { stamp: false, complete: false };
  const complete =
    facts.status === "in_progress" &&
    facts.loggerMembershipId !== null &&
    AUTO_COMPLETE_ON_RENDER_KINDS.includes(facts.kind as BereavementOutreachKind);
  return { stamp: true, complete };
}

/** What a rendered-document announcement is routed to (decided from the payload alone, before any IO). */
type RenderedRoute =
  | {
      readonly kind: "outreach";
      readonly documentId: string;
      readonly outreachId: string;
      readonly renderedAt: string;
    }
  | {
      readonly kind: "physician_letter";
      readonly documentId: string;
      readonly letterId: string;
      readonly renderedAt: string;
    }
  | {
      readonly kind: "discharge_summary";
      readonly documentId: string;
      readonly closureId: string;
      readonly renderedAt: string;
    };

/** The per-outreach facts the completion path reads. */
type RenderedFacts = Extract<RenderedRoute, { kind: "outreach" }>;

const renderedAtOf = (p: Record<string, unknown>): string =>
  typeof p.renderedAt === "string" && p.renderedAt.length > 0
    ? p.renderedAt
    : new Date().toISOString();

/** Route BEFORE any IO: null when the rendered document is not an M16 artifact this consumer back-refs. */
function routeOf(payload: unknown): RenderedRoute | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (p.sourceModule !== SOURCE_MODULE) return null;
  if (typeof p.documentId !== "string" || typeof p.aggregateId !== "string") return null;
  const renderedAt = renderedAtOf(p);
  if (p.sourceEvent === DOCUMENT_REQUESTED_EVENT) {
    if (p.aggregateType === PHYSICIAN_LETTER_AGGREGATE_TYPE) {
      return {
        kind: "physician_letter",
        documentId: p.documentId,
        letterId: p.aggregateId,
        renderedAt,
      };
    }
    if (p.aggregateType === DISCHARGE_SUMMARY_AGGREGATE_TYPE) {
      return {
        kind: "discharge_summary",
        documentId: p.documentId,
        closureId: p.aggregateId,
        renderedAt,
      };
    }
    return null;
  }
  if (p.sourceEvent !== SOURCE_EVENT) return null;
  if (p.aggregateType !== BEREAVEMENT_LETTER_AGGREGATE_TYPE) return null;
  if (p.templateKey === WELCOME_PACKET_TEMPLATE_KEY) return null;
  return { kind: "outreach", documentId: p.documentId, outreachId: p.aggregateId, renderedAt };
}

/** M16's live `m22.document.rendered` binding — the bereavement outreach artifact back-ref (D14). */
export function buildM16DocumentRenderedConsumer(deps: DocumentRenderedDeps) {
  return {
    consumerName: M16_DOCUMENT_RENDERED_CONSUMER.consumerName,
    consumerModule: "m16" as const,
    eventTypes: [M16_DOCUMENT_RENDERED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = routeOf(event.payload);
      if (facts === null) return;
      const organizationId = event.organizationId;
      if (facts.kind !== "outreach") {
        await stampPlanDocument(deps.db, organizationId, facts);
        return;
      }

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [outreach] = await tx
            .select()
            .from(OUTREACH)
            .where(
              and(eq(OUTREACH.organizationId, organizationId), eq(OUTREACH.id, facts.outreachId)),
            )
            .limit(1);
          if (!outreach) return; // not an outreach this org tracks — never a guessed back-ref

          const [plan] = await tx.select().from(PLAN).where(eq(PLAN.id, outreach.planId)).limit(1);
          if (!plan) return;

          const decision = decideRenderedBackref({
            kind: outreach.kind,
            status: outreach.status,
            renderedDocumentId: outreach.renderedDocumentId ?? null,
            loggerMembershipId: outreach.assigneeUserId ?? plan.assignedCounselorUserId ?? null,
          });
          if (!decision.stamp) return;

          const renderedAt = new Date(facts.renderedAt);
          if (decision.complete) {
            await completeOnRender(tx, deps, plan, outreach, facts);
          }
          const [stamped] = await tx
            .update(OUTREACH)
            .set({
              renderedDocumentId: facts.documentId,
              m22RenderedAt: renderedAt,
              // §2.5 (GAP-194) — every outreach write bumps the row version, so a counselor holding the
              // pre-render version gets 412 instead of overwriting the stamp / completion.
              version: sql`${OUTREACH.version} + 1`,
              updatedAt: new Date(),
              ...(decision.complete
                ? { status: "completed" as const, completedAt: renderedAt }
                : {}),
            })
            .where(
              and(
                eq(OUTREACH.id, outreach.id),
                eq(OUTREACH.status, outreach.status),
                isNull(OUTREACH.renderedDocumentId), // stamp once
              ),
            )
            .returning({ id: OUTREACH.id });
          // A completion that lost a race must roll back its log row + event (throw → retry → no-op); a
          // stamp-only miss is a concurrent identical stamp and is simply done.
          if (!stamped && decision.complete) {
            throw new Error("m16: the outreach changed underneath the render completion");
          }
        },
      );
    },
  };
}

type PlanRow = typeof PLAN.$inferSelect;
type OutreachRow = typeof OUTREACH.$inferSelect;

async function completeOnRender(
  tx: DbClient,
  deps: DocumentRenderedDeps,
  plan: PlanRow,
  outreach: OutreachRow,
  facts: RenderedFacts,
): Promise<void> {
  const at = facts.renderedAt as IsoInstant;
  const loggedBy = (outreach.assigneeUserId ?? plan.assignedCounselorUserId) as string;
  await tx.insert(LOG).values({
    organizationId: plan.organizationId,
    providerEntityId: plan.providerEntityId,
    locationId: plan.locationId,
    planId: plan.id,
    bereavedContactId: outreach.bereavedContactId,
    outreachId: outreach.id,
    contactAt: new Date(at),
    kind: outreach.kind,
    outcome: RENDERED_OUTCOME,
    sourceEncounterId: null, // D15 — a rendered artifact is never an M8 encounter
    contactNotesCipher: null,
    artifactDocumentId: facts.documentId,
    loggedByUserId: loggedBy,
    contactRespondedDirectly: false,
  });

  const completed = transitionBereavementOutreach(outreach.status, {
    type: "completeContact",
    at,
    kind: outreach.kind,
    outcome: RENDERED_OUTCOME,
    sourceEncounterId: null,
    contactLogCount: 1,
  });
  await runEffects(tx, completed.effects, {
    organizationId: plan.organizationId,
    at: new Date(at),
    outbox: deps.outbox,
    aggregateKind: "bereavement_plan",
    aggregateId: plan.id,
    payloads: {
      "m16.bereavement.outreach_completed": {
        planId: plan.id,
        contactId: outreach.bereavedContactId,
        outreachId: outreach.id,
        outcome: RENDERED_OUTCOME,
      },
    },
  });
}

/**
 * ADR-0109 D6 / D9 — stamp the plan-level document M22 rendered. Idempotent and conservative: the letter moves `approved -> rendered`
 * only while it has no document yet, and the closure takes the document id only while it has none; anything else (another tenant's
 * id, a letter that was never approved, a redelivery) matches no row and writes nothing.
 */
async function stampPlanDocument(
  db: DbClient,
  organizationId: string,
  route: Exclude<RenderedRoute, { kind: "outreach" }>,
): Promise<void> {
  await withOrgContext(db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    const renderedAt = new Date(route.renderedAt);
    if (route.kind === "physician_letter") {
      await tx
        .update(LETTER)
        .set({
          status: "rendered",
          renderedDocumentId: route.documentId,
          m22RenderedAt: renderedAt,
          version: sql`${LETTER.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(LETTER.organizationId, organizationId),
            eq(LETTER.id, route.letterId),
            eq(LETTER.status, "approved"),
            isNull(LETTER.renderedDocumentId),
          ),
        );
      return;
    }
    await tx
      .update(CLOSURE)
      .set({ dischargeSummaryDocumentId: route.documentId })
      .where(
        and(
          eq(CLOSURE.organizationId, organizationId),
          eq(CLOSURE.id, route.closureId),
          isNull(CLOSURE.dischargeSummaryDocumentId),
        ),
      );
  });
}
