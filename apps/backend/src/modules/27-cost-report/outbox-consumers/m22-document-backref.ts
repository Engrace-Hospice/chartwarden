// M27's live `m22.document.rendered` back-ref consumer — the §4.4 / §4.10 render handshake's return leg
// (F-108 / #103).
//
// ── WHAT WAS MISSING ─────────────────────────────────────────────────────────────────────────────────
//
// `ecr_submission.ecr_file_document_id`, `.pi_file_document_id` and `.supporting_documents_document_ids`
// are the columns M27 holds the Electronic Cost Report, the Print Image and the supporting bundle in —
// "M22 ref" in the schema, D11's "M27 holds back-references; no MinIO code". The `EcrSubmissionRepository`
// has carried an `update` accepting exactly those three since M27-T05. Nothing has ever called it with one.
//
// The upstream half went live in F-099: `m27.artifact.render_requested` is bound, M22 publishes the three
// `cost_report_*` templates, and every ECR generation since then has produced a real `document` row. The
// return leg did not exist. `handleDocumentRendered` — the pure decider for it — has been complete since
// M27-T09 with **no caller anywhere and no test anywhere**: `consumers/index.ts` states the absence as
// "the live inbound transactional-outbox dispatcher accessor lands (RULE 3(d))", a platform phase that
// landed. So the ECR file CMS receives exists in MinIO and the submission that produced it points at
// nothing; `GET /cost-reports/:id/submissions` serves `ecrFileDocumentId: null` for every attempt.
//
// ── THE PURE HANDLER'S DECLARED PAYLOAD DID NOT MATCH THE WIRE ───────────────────────────────────────
//
// `DocumentRenderedEvent` named `submissionId` and `artifactKind`. The published `m22.document.rendered`
// payload carries NEITHER — M27 fans three artifacts out under ONE request event name, so M22 routes each
// to its own template and its own `aggregate_type` and echoes back `aggregateType` + `aggregateId`. A
// binding written against the declared shape would have read `undefined` for both and no-op'd on every
// delivery, which is the F-030 attribute shape at payload granularity: silent, permanent, and
// indistinguishable from "no M27 document was rendered". The handler now reads the wire.
//
// ── FAIL-CLOSED ──────────────────────────────────────────────────────────────────────────────────────
//
// A document another module requested (`sourceModule !== 'm27'`), or one whose aggregate type is not one
// of M27's three, is a deliberate no-op. The scalar columns are stamped only when UNSET (the M11
// precedent: an at-least-once re-delivery re-announces the same document, and a W2 addendum announces a
// new VERSION of the same one — neither should overwrite a link a later, different render set). The
// supporting-docs bundle is an APPEND guarded by a jsonb containment predicate, so the same document id
// can never land in the array twice.
//
// The write and the `m27.artifact.stored_back_reference` emit share ONE `withOrgContext` transaction: the
// pure handler calls the two ports in sequence and they must commit together, or a crash between them
// would announce a back-reference that does not exist.
//
// The event name is a STRING literal and no M22 schema is imported — M27 reads M22 solely through the
// foundation outbox, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  type DocumentRenderedEvent,
  type M27ConsumerPorts,
  handleDocumentRendered,
} from "../consumers/handlers";
import type { WriteOutboxPort } from "../routes/write-service";

const E = schema.ecrSubmission;

export const M27_DOCUMENT_BACKREF_CONSUMER = {
  eventName: "m22.document.rendered",
  consumerName: "m27.document-backref",
} as const;

/** The minimal `m22.document.rendered` shape M27 reads (M22 owns the canonical payload). */
interface DocumentRenderedPayload {
  readonly documentId?: unknown;
  readonly aggregateType?: unknown;
  readonly aggregateId?: unknown;
  readonly sourceModule?: unknown;
}

/**
 * The three ports {@link handleDocumentRendered} never calls, bound to fail-closed thunks. The pure
 * dispatcher fans a topic out through ONE {@link M27ConsumerPorts} bundle, and this binding drains a single
 * topic; a port reached from here would be a routing bug, so it throws rather than no-ops (RULE 2).
 */
function unreachablePort(name: string): () => never {
  return () => {
    throw new Error(`${M27_DOCUMENT_BACKREF_CONSUMER.consumerName}: ${name} is not on this path`);
  };
}

export interface M27DocumentBackrefDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m27.artifact.stored_back_reference` against the boot catalog. */
  readonly outbox: WriteOutboxPort;
}

export function buildM27DocumentBackrefConsumer(
  deps: M27DocumentBackrefDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M27_DOCUMENT_BACKREF_CONSUMER.consumerName,
    consumerModule: "m27",
    eventTypes: [M27_DOCUMENT_BACKREF_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const p = (event.payload ?? {}) as DocumentRenderedPayload;
      // Narrow before opening a transaction: most deliveries of this event are another module's document.
      if (p.sourceModule !== "m27") return;
      if (
        typeof p.aggregateType !== "string" ||
        typeof p.aggregateId !== "string" ||
        typeof p.documentId !== "string"
      ) {
        return;
      }
      const organizationId = event.organizationId;
      const rendered: DocumentRenderedEvent = {
        eventId: event.id,
        sourceModule: p.sourceModule,
        aggregateType: p.aggregateType,
        aggregateId: p.aggregateId,
        documentId: p.documentId,
      };

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const ports: M27ConsumerPorts = {
          async recordArtifactBackReference(write) {
            const { column, append } = write.target;
            if (append) {
              // Idempotent APPEND: the containment predicate makes a re-delivery a zero-row update rather
              // than a second copy of the same id in the bundle.
              await tx
                .update(E)
                .set({
                  supportingDocumentsDocumentIds: sql`${E.supportingDocumentsDocumentIds} || to_jsonb(${write.documentId}::text)`,
                })
                .where(
                  and(
                    eq(E.organizationId, organizationId),
                    eq(E.id, write.submissionId),
                    sql`NOT (${E.supportingDocumentsDocumentIds} @> to_jsonb(${write.documentId}::text))`,
                  ),
                );
              return;
            }
            const target =
              column === "ecr_file_document_id" ? E.ecrFileDocumentId : E.piFileDocumentId;
            await tx
              .update(E)
              .set(
                column === "ecr_file_document_id"
                  ? { ecrFileDocumentId: write.documentId }
                  : { piFileDocumentId: write.documentId },
              )
              .where(
                and(
                  eq(E.organizationId, organizationId),
                  eq(E.id, write.submissionId),
                  isNull(target),
                ),
              );
          },
          outbox: {
            async emitArtifactStoredBackReference(payload) {
              await deps.outbox.publish(tx, {
                eventName: "m27.artifact.stored_back_reference",
                organizationId,
                aggregateKind: "ecr_submission",
                aggregateId: payload.submissionId,
                payload: { ...payload },
              });
            },
            emitRuleSuggestionCreated: unreachablePort("emitRuleSuggestionCreated"),
            emitCostReportClosed: unreachablePort("emitCostReportClosed"),
          },
          isRejectionCodeCovered: unreachablePort("isRejectionCodeCovered"),
          createDraftSuggestionRule: unreachablePort("createDraftSuggestionRule"),
          listOpenCostReportsForProvider: unreachablePort("listOpenCostReportsForProvider"),
          closeCostReport: unreachablePort("closeCostReport"),
        };
        await handleDocumentRendered(rendered, ports);
      });
    },
  };
}
