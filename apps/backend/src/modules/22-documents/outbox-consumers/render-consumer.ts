// apps/backend/src/modules/22-documents/outbox-consumers/render-consumer.ts — GAP-023/024/038. The LIVE
// §4.11 render-handshake consumer: the half that was forward-declared in ./bindings.ts and never built.
//
// Before this file NOTHING drained a `*.document_requested` row. The pure decider (T06
// {@link decideDocumentRequest}), the two real seam gates (M39 consent / M40 BAA), the T04
// `DocumentRenderer`, and — since GAP-095 — a Drizzle document-row write store all existed and were
// individually tested; the dispatcher was simply never told about any of them. So M13's
// `finalize-reconciliation` (the ONE source module that genuinely emits) wrote an outbox row that sat
// `pending` forever, and the audit's "M22 is ready and waiting for this event" (GAP-023) was true only of
// a `const` array of strings. This binding closes the loop: normalize → resolve facts → decide → render.
//
// Why the normalizer exists: each source module owns its own payload wire shape (M11/M12 emit
// `{orderId, formTemplate, renderPayload}`, M13 `{worksheetId, …}`, M23's ABN a flat financial record) and
// M22 must not import any of them (deps stay `[1, 5]` — event STRINGS only, §4 boundary rule). The §4.11
// {@link DocumentRequestPayload} is M22's own canonical shape; {@link normalizeDocumentRequest} is the pure,
// per-event adapter into it. An event whose payload does not normalize THROWS — the dispatcher retries then
// dead-letters it (§7.2), which is the honest outcome for a malformed render request; it is never a silent
// no-op that would leave a signed clinical artifact permanently un-rendered with a green outbox.
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { getDocumentRenderer } from "../seams";
import { PLATFORM_TEMPLATE_TABLE, type TemplateDescriptor } from "../seams/renderer";
import type { DocumentSeamStore } from "../seams/store";
import { resolveExternalBaaActive } from "./baa-gate";
import { M22_DOCUMENT_RENDER_CONSUMER } from "./bindings";
import { resolveSudConsentPresent } from "./consent-gate";
import {
  type DocumentRequestEvent,
  type DocumentRequestFacts,
  type DocumentRequestPayload,
  M22_DOCUMENT_REQUEST_EVENTS,
  decideDocumentRequest,
} from "./decide-document-request";

// ── The per-event payload adapter (pure) ────────────────────────────────────────────────────────────────

/** How one source module's wire payload maps onto M22's canonical {@link DocumentRequestPayload}. Kept as
 * DATA (not a switch) so adding a source module is one row, and so the whole mapping is assertable. */
interface RequestShape {
  /** Payload field(s) holding the source aggregate id — the first present, non-empty string wins. Empty
   *  when the identity is only on the ENVELOPE (see {@link aggregateIdFromEvent}). */
  readonly aggregateIdFields: readonly string[];
  /** Take the aggregate id from the outbox row's own `aggregate_id` rather than the payload. M21 needs
   *  this: its return-receipt request carries `dispatchId` in the body but the RETURN row's id on the
   *  envelope, so the body would back-ref the wrong artifact. */
  readonly aggregateIdFromEvent?: boolean;
  /** The M22 template key, when the source module's own form-template name is NOT one (M13 asks for
   *  `reconciliation_worksheet_v1`; M22's published key is `medication_reconciliation_worksheet`). */
  readonly templateKey?: string;
  /** Payload field holding the source's own template name, used when {@link templateKey} is absent. */
  readonly templateKeyField?: string;
  /** One event carrying SEVERAL artifacts, discriminated by a payload field: `{field, map}` resolves the
   *  M22 template key from the discriminator's value. A value absent from the map is a malformed request
   *  (a throw), never a guess — rendering the wrong document under a real patient's chart is worse than
   *  a dead letter. */
  readonly templateKeyByField?: {
    readonly field: string;
    readonly map: Readonly<Record<string, string>>;
  };
  /** Payload field holding the render content blob (passed through to the byte renderer). */
  readonly contentField?: string;
}

/** The §4.11 wire shapes, one per LIVE consumed event (see {@link M22_DOCUMENT_REQUEST_EVENTS}). */
const REQUEST_SHAPES: Readonly<Record<DocumentRequestEvent, RequestShape>> = {
  // M11 §4.4 — "mirror of `m11.order.signed`". `formTemplate` IS the M22 key (`order_record`).
  "m11.order.document_requested": {
    aggregateIdFields: ["orderId"],
    templateKeyField: "formTemplate",
    contentField: "renderPayload",
  },
  // M12 §4.4 — same shape as M11; `formTemplate` is `medication_order`.
  "m12.medication_order.document_requested": {
    aggregateIdFields: ["orderId"],
    templateKeyField: "formTemplate",
    contentField: "renderPayload",
  },
  // M13 — the one source module that already emitted before this consumer existed. Its `formTemplate`
  // (`reconciliation_worksheet_v1`) is M13's OWN form name, not an M22 published key, so the key is fixed
  // here rather than read off the payload.
  "m13.reconciliation.document_requested": {
    aggregateIdFields: ["worksheetId"],
    templateKey: "medication_reconciliation_worksheet",
    contentField: "renderPayload",
  },
  // M21 §4.5.2 — ONE event, TWO artifacts, discriminated by `documentKind`. M21 has been emitting this
  // from both write paths since it landed with nothing consuming it. The aggregate identity is on the
  // ENVELOPE, not the body: `prepareDispatch` publishes with aggregate `comfort_kit_dispatch`/dispatch.id
  // and the return path with `comfort_kit_return`/return.id, while BOTH bodies carry `dispatchId` — so
  // reading the body would file the return receipt against the dispatch.
  "m21.supply_request.document_requested": {
    aggregateIdFields: [],
    aggregateIdFromEvent: true,
    templateKeyByField: {
      field: "documentKind",
      map: {
        bill_of_lading: "supply_bill_of_lading",
        return_receipt: "comfort_kit_return_receipt",
      },
    },
  },
  // M23 §4.10 (GAP-038) — the CMS-R-131 ABN. A flat financial record, no `formTemplate` field at all: the
  // event name itself names the artifact, so the template key is fixed and the whole payload is content.
  "m23.abn.required": {
    aggregateIdFields: ["abnId"],
    templateKey: "abn",
  },
  // M33 §1.1 (GAP-051) — ONE wire name, TWO producers: the `report.scheduled_run` cron path
  // (`report_schedule_run`, aggregate = the run) and the ad-hoc "export now" route (`report_export`,
  // aggregate = the export). They are two different `document_aggregate_type`s, so the payload's own
  // `aggregateType` picks the template. The identity is taken from the ENVELOPE for the same reason M21's
  // is: both producers set the outbox row's aggregate correctly, and only the ad-hoc payload happens to
  // repeat it in the body. No `contentField` — the WHOLE payload is the report (columns + rows + the
  // format + the snapshot query's provenance), which is exactly what the renderer should receive.
  "m33.scheduled_report.render_requested": {
    aggregateIdFields: [],
    aggregateIdFromEvent: true,
    templateKeyByField: {
      field: "aggregateType",
      map: {
        report_export: "report_export",
        report_schedule_run: "scheduled_report",
      },
    },
  },
  // ── F-099 — the six request-spelled events that were emitted and drained by nothing ───────────────────
  // M10 §2.4 — `POST /hope/assessments/:id/summary-pdf`. One artifact, so the key is fixed; no
  // `contentField`, because the whole payload (the assessment id + who asked) is what the summary renders
  // from. `patientId` rides the payload as of F-099 — see the note at the head of the file about why the
  // chart target has to be on the wire rather than resolved here.
  "m10.hope.summary_requested": {
    aggregateIdFields: ["assessmentId"],
    templateKey: "hope_summary",
  },
  // M16 D14 — the payload names its own template key (`bereavement_welcome_packet`), the M11/M12
  // `formTemplate` shape. The aggregate is the PLAN, not the contact: one welcome packet per plan, and
  // filing it against `contactId` would make a second contact's packet a fresh render of a document the
  // family already has. `outreachId` is legitimately null at plan-open and is not an identity here.
  "m16.bereavement.outreach_artifact_requested": {
    aggregateIdFields: ["planId"],
    templateKeyField: "templateKey",
    contentField: "payloadJsonb",
  },
  // M20 §4.10 — "M22's renderer consumes it; M20 ships no PDF code". `renderTargetKind` is a literal
  // `"pdf"`, so it discriminates nothing and the key is fixed.
  "m20.safety.incident_report_requested": {
    aggregateIdFields: ["incidentId"],
    templateKey: "safety_incident_report",
  },
  // M25 — the tier-specific appeal letter. `tier` selects the letter's CONTENT, not a different artifact
  // (an ALJ appeal is the same document class as a redetermination), so it stays in the content blob
  // rather than becoming a template discriminator.
  "m25.appeal_packet.render_requested": {
    aggregateIdFields: ["appealCaseId"],
    templateKey: "appeal_packet",
    contentField: "payload",
  },
  // M27 §4.10 — ONE wire name, THREE artifacts, discriminated by `artifactKind`. The aggregate is the
  // SUBMISSION (`submissionId`), not the cost report: a reopened report submits again, and filing both
  // against `costReportId` would make the second render an idempotent skip of the first.
  "m27.artifact.render_requested": {
    aggregateIdFields: ["submissionId"],
    templateKeyByField: {
      field: "artifactKind",
      map: {
        ecr: "cost_report_ecr",
        pi: "cost_report_pi",
        supporting_doc: "cost_report_supporting_doc",
      },
    },
  },
  // M37 §2.11 — emitted by the body-release machine on `identifyFuneralHome`.
  // `ipu_body_release.release_document_id` is the column waiting for it, and its schema comment names this
  // template. The identity is on the BODY (`bodyReleaseId`), which the service publishes as the envelope
  // aggregate too — the body is used because it is the field the catalog pins.
  "m37.body_release.document_requested": {
    aggregateIdFields: ["bodyReleaseId"],
    templateKey: "body_release_authorization",
  },
};

/** Raised when a delivered render request cannot be read into M22's canonical shape (unknown event name,
 * missing aggregate id, or a template key the payload never names). The dispatcher retries then
 * dead-letters — a malformed render request is evidence, never a silent skip. */
export class MalformedRenderRequestError extends Error {
  readonly code = "MALFORMED_RENDER_REQUEST";
  constructor(eventType: string, why: string) {
    super(`render request '${eventType}' is not renderable: ${why}`);
    this.name = "MalformedRenderRequestError";
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * Adapt one source module's delivered payload into M22's canonical §4.11 {@link DocumentRequestPayload}
 * (pure). `organizationId` comes from the OUTBOX ROW, never the payload body — the row is the RLS-scoped,
 * dispatcher-verified tenant anchor; a payload-carried org would be caller-asserted (M23's ABN payload does
 * carry one, and it is deliberately ignored here).
 *
 * @throws MalformedRenderRequestError when the event is not a known §4.11 request or the payload lacks the
 * aggregate identity / template key the render needs.
 */
export function normalizeDocumentRequest(delivered: {
  readonly eventType: string;
  readonly organizationId: string;
  /** The outbox row's own `aggregate_id` — the identity for shapes that carry it on the envelope. */
  readonly aggregateId?: string;
  readonly payload: unknown;
}): { event: DocumentRequestEvent; payload: DocumentRequestPayload } {
  const { eventType, organizationId, payload: rawPayload } = delivered;
  const shape = (REQUEST_SHAPES as Record<string, RequestShape | undefined>)[eventType];
  if (!shape) throw new MalformedRenderRequestError(eventType, "not a §4.11 render-request event");
  if (!rawPayload || typeof rawPayload !== "object") {
    throw new MalformedRenderRequestError(eventType, "payload is not an object");
  }
  const p = rawPayload as Record<string, unknown>;

  const aggregateId = shape.aggregateIdFromEvent
    ? str(delivered.aggregateId)
    : shape.aggregateIdFields.map((f) => str(p[f])).find((v) => v !== undefined);
  if (!aggregateId) {
    throw new MalformedRenderRequestError(
      eventType,
      shape.aggregateIdFromEvent
        ? "the outbox row carries no aggregate_id"
        : `payload names no aggregate id (looked at ${shape.aggregateIdFields.join(", ")})`,
    );
  }

  const byField = shape.templateKeyByField;
  const discriminator = byField ? str(p[byField.field]) : undefined;
  if (byField && discriminator !== undefined && byField.map[discriminator] === undefined) {
    throw new MalformedRenderRequestError(
      eventType,
      `${byField.field} '${discriminator}' maps to no M22 template`,
    );
  }
  const templateKey =
    shape.templateKey ??
    (discriminator !== undefined ? byField?.map[discriminator] : undefined) ??
    (shape.templateKeyField ? str(p[shape.templateKeyField]) : undefined);
  if (!templateKey) {
    throw new MalformedRenderRequestError(
      eventType,
      `payload names no template (expected '${shape.templateKeyField ?? byField?.field}')`,
    );
  }

  const rawContent = shape.contentField ? p[shape.contentField] : p;
  const content =
    rawContent && typeof rawContent === "object" ? (rawContent as Record<string, unknown>) : {};

  // The chart-target patient may live on the envelope (M21/M23 style) or inside the content blob (M11/M12
  // thread it through `renderPayload`, whose schema is `Type.Unknown()` — no catalog change needed).
  const patientId = str(p.patientId) ?? str(content.patientId) ?? null;

  return {
    event: eventType as DocumentRequestEvent,
    payload: {
      organizationId,
      templateKey,
      aggregateId,
      patientId,
      content,
      ...(p.isSudClass === true || content.isSudClass === true ? { isSudClass: true } : {}),
      ...(str(p.title) ? { title: str(p.title) as string } : {}),
    },
  };
}

// ── The live consumer ───────────────────────────────────────────────────────────────────────────────────

export interface DocumentRequestConsumerDeps {
  /** The document-ROW store — the idempotency fact (`renderedDocumentForAggregate`) comes from the real
   *  `document` table, not a separate dedup registry: the rendered row IS the durable record of the render,
   *  so a re-delivery after a crash between render and receipt still cannot double-render. */
  readonly store: DocumentSeamStore;
  /** Overridable for tests; production resolves M22's own registered `DocumentRenderer` seam lazily (the
   *  seam is registered at boot, before the dispatcher starts, but resolving per-call keeps a re-registered
   *  seam — every test boot does this — from being captured at construction time). */
  readonly renderer?: () => {
    render(
      scope: { orgId: string },
      templateKey: string,
      payload: unknown,
    ): Promise<{ documentId: string }>;
  };
  /** Structured sink for the three REFUSAL outcomes (unknown template / SUD consent absent / BAA inactive).
   *  A refusal is a decision with a reason, not an error: it must be visible without being a dead letter. */
  readonly onRefusal?: (refusal: {
    readonly eventType: string;
    readonly organizationId: string;
    readonly aggregateId: string;
    readonly kind: "unknown_template" | "sud_consent_absent" | "baa_inactive";
    readonly detail: string;
  }) => void;
  /** Template table override (tests); defaults to the T04 published table. */
  readonly templates?: Readonly<Record<string, TemplateDescriptor>>;
  /**
   * The §7.2 downstream half: emits `m22.document.rendered` so the requesting module can stamp its own
   * back-ref column. Optional — omitted, the render still happens and the document is still reachable
   * through `document.(aggregate_type, aggregate_id)`; the source row's column simply stays NULL.
   */
  readonly emitRendered?: (event: DocumentRenderedEmit) => Promise<void>;
}

/** The `m22.document.rendered` payload (see ../events-by-m22.ts) as the consumer hands it to the emitter. */
export interface DocumentRenderedEmit {
  readonly organizationId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly versionNumber: number;
  readonly isFirstVersion: boolean;
  readonly templateKey: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly retentionClass: string;
  readonly patientId: string | null;
  readonly sourceEvent: string;
  readonly sourceModule: string;
  readonly renderedAt: string;
}

/** `m11.order.document_requested` → `m11`. The producer is the event name's own namespace — M22 reads every
 *  source module through the event STRING, so the string is also where the requester's identity lives. */
function sourceModuleOf(eventName: string): string {
  return eventName.split(".")[0] ?? "";
}

/**
 * Build the LIVE §4.11 render-handshake consumer (GAP-023/024/038). One binding drains every consumed
 * `*.document_requested` queue: it normalizes the source payload, resolves {@link DocumentRequestFacts}
 * (idempotency from the `document` table, the template descriptor from the T04 table, and — only when the
 * payload flags them — the M39 consent and M40 BAA gates), calls the pure {@link decideDocumentRequest},
 * and executes the returned action through the T04 `DocumentRenderer`.
 *
 * `unknown_template` THROWS (retry-then-dead-letter per §7.2 — a template that has not been published yet
 * may be published in a minute, and the request must survive until it is). The two GATE refusals do NOT
 * throw: they are settled decisions — a SUD render with no consent must never be retried into existence —
 * so the row completes and the refusal goes to {@link DocumentRequestConsumerDeps.onRefusal}.
 */
export function buildM22DocumentRequestConsumer(
  deps: DocumentRequestConsumerDeps,
): OutboxConsumerBinding {
  const templates = deps.templates ?? PLATFORM_TEMPLATE_TABLE;
  const renderer = deps.renderer ?? getDocumentRenderer;

  return {
    consumerName: M22_DOCUMENT_RENDER_CONSUMER,
    consumerModule: "m22",
    eventTypes: [...M22_DOCUMENT_REQUEST_EVENTS],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const { event: sourceEvent, payload } = normalizeDocumentRequest(event);

      const descriptor = templates[payload.templateKey];
      const prior = descriptor
        ? await deps.store.renderedDocumentForAggregate({
            aggregateType: descriptor.aggregateType,
            aggregateId: payload.aggregateId,
            organizationId: payload.organizationId,
          })
        : null;

      const facts: DocumentRequestFacts = {
        alreadyRendered: prior !== null,
        templateKnown: descriptor !== undefined,
        aggregateType: descriptor?.aggregateType ?? null,
        retentionClass: descriptor?.retentionClass ?? null,
        // Both gates are resolved ONLY when the payload flags them (the decider reads them only then), so a
        // routine clinical render never pays for an M39/M40 seam call.
        ...(payload.isSudClass === true && payload.patientId
          ? {
              sudConsentPresent: await resolveSudConsentPresent({
                organizationId: payload.organizationId,
                patientId: payload.patientId,
              }),
            }
          : {}),
        ...(payload.externalRecipient
          ? {
              externalBaaActive: await resolveExternalBaaActive({
                organizationId: payload.organizationId,
                recipient: payload.externalRecipient,
              }),
            }
          : {}),
      };

      /** Emit the §7.2 downstream half for a document that now exists. Shared by the render path and the
       *  re-delivery path — see the `idempotent_skip` note below for why the latter must emit too. */
      const announce = async (row: {
        documentId: string;
        versionId: string;
        versionNumber: number;
        renderedAt: string;
      }): Promise<void> => {
        if (!deps.emitRendered || !descriptor) return;
        await deps.emitRendered({
          organizationId: payload.organizationId,
          documentId: row.documentId,
          documentVersionId: row.versionId,
          versionNumber: row.versionNumber,
          isFirstVersion: row.versionNumber === 1,
          templateKey: payload.templateKey,
          aggregateType: descriptor.aggregateType,
          aggregateId: payload.aggregateId,
          retentionClass: descriptor.retentionClass,
          patientId: payload.patientId ?? null,
          sourceEvent,
          sourceModule: sourceModuleOf(sourceEvent),
          renderedAt: row.renderedAt,
        });
      };

      const action = decideDocumentRequest(sourceEvent, payload, facts);
      switch (action.kind) {
        case "idempotent_skip":
          // D14 — a re-delivery never produces a second DOCUMENT. It must still ANNOUNCE one: the render
          // and the emit are two transactions (the renderer opens its own), so a crash between them is
          // exactly the case that gets redelivered, and returning here would make that the one path where
          // the back-ref is lost permanently — silently, and only under a crash. Consumers stamp the same
          // `document_id` they already hold, which is idempotent by construction.
          if (prior) await announce(prior);
          return;
        case "unknown_template":
          deps.onRefusal?.({
            eventType: event.eventType,
            organizationId: payload.organizationId,
            aggregateId: payload.aggregateId,
            kind: "unknown_template",
            detail: action.templateKey,
          });
          // Retry-then-DLQ (§7.2): the request outlives a not-yet-published template.
          throw new MalformedRenderRequestError(
            event.eventType,
            `no published M22 template for key '${action.templateKey}'`,
          );
        case "sud_consent_absent":
          deps.onRefusal?.({
            eventType: event.eventType,
            organizationId: payload.organizationId,
            aggregateId: payload.aggregateId,
            kind: "sud_consent_absent",
            detail: action.templateKey,
          });
          return; // §7.16 — settled refusal, never retried into a plaintext SUD render.
        case "baa_inactive":
          deps.onRefusal?.({
            eventType: event.eventType,
            organizationId: payload.organizationId,
            aggregateId: payload.aggregateId,
            kind: "baa_inactive",
            detail: action.mdmEntityId,
          });
          return; // §4.12 — settled refusal; no out-of-network disclosure without an active BAA.
        case "render": {
          const { render } = action;
          await renderer().render({ orgId: payload.organizationId }, render.templateKey, {
            aggregateId: render.aggregateId,
            patientId: render.patientId,
            ...(render.title ? { title: render.title } : {}),
            ...render.content,
            ...(render.sudRedacted ? { sudRedacted: true } : {}),
          });
          // Re-read rather than trusting the renderer's `{documentId}`: the leaf-typed `DocumentRenderer`
          // seam returns only that, and the back-ref event carries the version identity too. This read is
          // the same row the render just wrote, under the same org.
          if (deps.emitRendered && descriptor) {
            const written = await deps.store.renderedDocumentForAggregate({
              aggregateType: descriptor.aggregateType,
              aggregateId: payload.aggregateId,
              organizationId: payload.organizationId,
            });
            if (written) await announce(written);
          }
          return;
        }
      }
    },
  };
}
