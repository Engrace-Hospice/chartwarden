import { runWithRequestContext } from "@chartwarden/tenancy";
// apps/backend/src/modules/22-documents/render-variants/medication-list-bindings.ts — F-171 (#248) the
// LIVE `m12.medication_order.list_changed` → `patient_medication_list` render binding. Unlike
// `lab-backref-bindings.ts` (deny-stub, M29 unbuilt), M12's `MedicationOrderProvider` seam is real and
// registered in production (M12-T07) — this file is genuinely wired into the composition root, not
// forward-declared.
//
// AMBIENT REQUEST CONTEXT REQUIRED — the same, previously-documented (F-153/F-118) M17/M18 shape, found
// again here rather than assumed working: M12's `DoseSpotSeamStore.medicationOrdersForPatient` (the read
// behind `MedicationOrderProvider.getActiveMedications`, `12-dosespot/seams/drizzle-store.ts`) opens
// `withOrgContextFromRequest`, which THROWS outside an active `runWithRequestContext` scope — and a
// dispatcher tick delivering this event is not a request. Fixed the same way every other cross-module seam
// read from inside an outbox consumer is fixed on this platform: `runWithRequestContext({organizationId,
// userId: CONSUMER_USER_ID}, …)` wraps the seam call, establishing the scope before `getSeam(
// "MedicationOrderProvider")` is ever invoked. `CONSUMER_USER_ID = ""` is the established dispatcher
// convention (F-102) for a system-attributed read — this is a READ, so it never reaches an
// `actorMembershipId` column the way F-102's write-path convention does.
import type { MedicationOrderDto } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { resolveSudConsentPresent } from "../outbox-consumers/consent-gate";
import type { DocumentRenderedEmit } from "../outbox-consumers/render-consumer";
import { getDocumentRenderer } from "../seams";
import { PLATFORM_TEMPLATE_TABLE, type TemplateDescriptor } from "../seams/renderer";
import type { DocumentSeamStore } from "../seams/store";
import {
  M22_MEDICATION_LIST_CONSUMER,
  M22_MEDICATION_LIST_EVENT,
  type MedicationListChangedPayload,
  type MedicationListFacts,
  decideMedicationListRender,
} from "./medication-list-consumer";
import type { PatientMedicationListRenderPayload } from "./render-variants";

/** Raised when the delivered `.list_changed` payload does not carry a usable `patientId` (malformed — the
 * dispatcher retries then dead-letters, §7.2; never a silent skip of a real request). */
export class MalformedMedicationListRequestError extends Error {
  readonly code = "MALFORMED_MEDICATION_LIST_REQUEST";
  constructor(why: string) {
    super(`m12.medication_order.list_changed is not renderable: ${why}`);
    this.name = "MalformedMedicationListRequestError";
  }
}

function parsePayload(raw: unknown): MedicationListChangedPayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (typeof p.patientId !== "string" || p.patientId.length === 0) {
    throw new MalformedMedicationListRequestError("payload names no patientId");
  }
  const addedOrderIds = Array.isArray(p.addedOrderIds)
    ? p.addedOrderIds.filter((v): v is string => typeof v === "string")
    : [];
  const removedOrderIds = Array.isArray(p.removedOrderIds)
    ? p.removedOrderIds.filter((v): v is string => typeof v === "string")
    : [];
  return { patientId: p.patientId, addedOrderIds, removedOrderIds };
}

/** The dispatcher's own system-attribution convention (F-102) for a consumer-driven seam read with no
 *  human actor. */
const CONSUMER_USER_ID = "";

/** Mirrors M12's own (private) `layInstructions` (`12-dosespot/seams/providers.ts`) — the lay-language sig
 * summary every M12 read projection derives the same way. Duplicated rather than imported: M22 `dependsOn`
 * is `[1, 5]` and cannot import `@chartwarden/dosespot`/M12's own module code (only its leaf `@chartwarden/types`
 * DTO + the opaque seam). */
function sigSummaryOf(order: MedicationOrderDto): string {
  const s = order.sigStructured;
  const base = `Take ${s.doseQuantity} ${s.doseUnit} by ${s.route}, ${s.frequencyCode}`;
  return s.asNeeded ? `${base} as needed` : base;
}

/**
 * `MedicationOrderProvider` is typed (not `unknown`) in the leaf `SeamContracts` map
 * (`packages/types/src/seams.ts`), since `MedicationOrderProvider` itself already lives in `@chartwarden/types`
 * — unlike `ConsentEvaluator`/`TerminologyProvider`, which are opaque there because their rich interfaces
 * live in a producer package M22 has no edge to. So `getSeam("MedicationOrderProvider")` returns the real
 * interface directly below — no local structural port or cast needed (the M30 `index.ts` composition-root
 * precedent: `getSeam("MedicationOrderProvider")` with no cast), resolved opaquely from the M1 registry,
 * never a `@chartwarden/dosespot` import.
 *
 * Resolve the patient's CURRENT active-medication set via M12's real `MedicationOrderProvider` seam (the
 * fresh-at-delivery-time read this event's diff payload cannot supply; see the consumer file header).
 * Wraps the call in `runWithRequestContext` (see this file's own header — the backing Drizzle read throws
 * without an ambient request scope). ANY failure — the seam not registered (a required seam; a deny-stub
 * throws rather than silently returning `[]`, see `medicationOrderProviderDenyStub`'s own doc comment), or
 * a real read error — degrades to `null`, NEVER a fabricated or silently-empty list; an empty array IS a
 * legitimate, distinct resolved outcome (every order discontinued), never confused with `null` (unresolved).
 */
export async function resolveActiveMedicationsForPatient(
  organizationId: string,
  patientId: string,
): Promise<readonly MedicationOrderDto[] | null> {
  try {
    return await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
      const provider = getSeam("MedicationOrderProvider");
      return await provider.getActiveMedications(organizationId, patientId);
    });
  } catch {
    return null; // fail-closed — the active-medication seam is unavailable ⇒ defer the render (§7.2)
  }
}

export interface MedicationListConsumerDeps {
  /** The document-ROW store — see `render-consumer.ts`'s identical field for why a SECOND store instance
   *  (over the same tables) is correct here rather than sharing one. */
  readonly store: DocumentSeamStore;
  /** Overridable for tests; production resolves M22's registered `DocumentRenderer` seam lazily. */
  readonly renderer?: () => {
    render(
      scope: { orgId: string },
      templateKey: string,
      payload: unknown,
    ): Promise<{ documentId: string }>;
  };
  /** Overridable for tests; defaults to {@link resolveActiveMedicationsForPatient}. */
  readonly resolveActiveMedications?: (
    organizationId: string,
    patientId: string,
  ) => Promise<readonly MedicationOrderDto[] | null>;
  /** Overridable for tests; defaults to {@link resolveSudConsentPresent} (`../outbox-consumers/consent-gate`). */
  readonly resolveConsentPresent?: (input: {
    organizationId: string;
    patientId: string;
  }) => Promise<boolean>;
  /** Injectable clock for `asOfIso` — deterministic tests. Defaults to real time. */
  readonly now?: () => string;
  /** Structured sink for the one REFUSAL outcome (M12's seam unavailable) — a defer is a decision with a
   *  reason, not a silent drop; the dispatcher still retries-then-DLQs (this consumer THROWS on it). */
  readonly onRefusal?: (refusal: {
    readonly eventType: string;
    readonly organizationId: string;
    readonly patientId: string;
    readonly detail: string;
  }) => void;
  /** The §7.2 downstream half — optional (see `render-consumer.ts`'s identical field; nothing currently
   *  back-refs a patient-level document id, so the render stays discoverable via `document.(aggregate_type,
   *  aggregate_id)` regardless of whether this is wired). */
  readonly emitRendered?: (event: DocumentRenderedEmit) => Promise<void>;
  /** Template table override (tests); defaults to the T04 published table. */
  readonly templates?: Readonly<Record<string, TemplateDescriptor>>;
}

/** `m12.medication_order.list_changed` → `m12` (the F-171 sibling of `render-consumer.ts`'s
 *  `sourceModuleOf`, inlined since this file consumes exactly one event name). */
const SOURCE_MODULE = "m12";

/**
 * Build the LIVE `m12.medication_order.list_changed` → `patient_medication_list` render consumer (F-171,
 * #248). Resolves the patient's CURRENT active-medication set via M12's real seam (never the delivered
 * diff payload), shapes it into the §7.16 SUD-aware render content, and writes it through M22's document
 * store — a NEW `document_version` per genuinely distinct delivered event (never a re-render of an
 * already-processed one; see the consumer file header for the idempotency granularity).
 */
export function buildM22MedicationListConsumer(
  deps: MedicationListConsumerDeps,
): OutboxConsumerBinding {
  const templates = deps.templates ?? PLATFORM_TEMPLATE_TABLE;
  const renderer = deps.renderer ?? getDocumentRenderer;
  const resolveActiveMedications =
    deps.resolveActiveMedications ?? resolveActiveMedicationsForPatient;
  const resolveConsentPresent = deps.resolveConsentPresent ?? resolveSudConsentPresent;
  const now = deps.now ?? (() => new Date().toISOString());
  const descriptor = templates.patient_medication_list;

  /** Emit the §7.2 downstream half for a document version that now exists (genesis, a new append, or a
   *  re-delivery re-announce). One call site for all three — see the three `deps.emitRendered` call sites
   *  below, none of which duplicate this. */
  const announce = async (args: {
    organizationId: string;
    patientId: string;
    row: { documentId: string; versionId: string; versionNumber: number; renderedAt: string };
  }): Promise<void> => {
    if (!deps.emitRendered || !descriptor) return;
    await deps.emitRendered({
      organizationId: args.organizationId,
      documentId: args.row.documentId,
      documentVersionId: args.row.versionId,
      versionNumber: args.row.versionNumber,
      isFirstVersion: args.row.versionNumber === 1,
      templateKey: "patient_medication_list",
      aggregateType: descriptor.aggregateType,
      aggregateId: args.patientId,
      retentionClass: descriptor.retentionClass,
      patientId: args.patientId,
      sourceEvent: M22_MEDICATION_LIST_EVENT,
      sourceModule: SOURCE_MODULE,
      renderedAt: args.row.renderedAt,
    });
  };

  return {
    consumerName: M22_MEDICATION_LIST_CONSUMER,
    consumerModule: "m22",
    eventTypes: [M22_MEDICATION_LIST_EVENT],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const payload = parsePayload(event.payload);

      // F-168 (#248) per-request granularity: this exact delivered outbox event id, never the coarser
      // (aggregateType, aggregateId) key — every genuinely new `.list_changed` event for the same patient
      // must produce a NEW document version, so the aggregate-level key (which would `idempotent_skip`
      // every delivery after the first) is the wrong tool here, the identical reasoning `render-consumer
      // .ts`'s `appends: true` events use.
      const prior = await deps.store.documentVersionForSourceEvent({
        sourceEventId: event.id,
        organizationId: event.organizationId,
      });
      if (prior) {
        // Re-delivery of the SAME outbox row (crash between render and receipt) — re-announce the same
        // version, never render a second one for this one request (render-consumer.ts's identical
        // "idempotent_skip must still announce" reasoning — a source module's own back-ref, if wired
        // later, would otherwise be permanently lost for exactly the redelivered case).
        await announce({
          organizationId: event.organizationId,
          patientId: payload.patientId,
          row: prior,
        });
        return;
      }

      // `prior === null` here (the branch above returned) — resolving the M12 seam only when there is
      // genuinely nothing rendered yet for this event avoids paying for it on every redelivery.
      const medications = await resolveActiveMedications(event.organizationId, payload.patientId);
      const facts: MedicationListFacts = {
        alreadyRendered: false, // structurally guaranteed false past the early-return above
        medicationsResolved: medications !== null,
        renderPayload:
          medications === null
            ? null
            : ({
                patientId: payload.patientId,
                asOfIso: now(),
                medications: medications.map((m) => ({
                  medicationOrderId: m.id,
                  drugName: m.drugName,
                  strength: m.strength,
                  doseForm: m.doseForm,
                  route: m.route,
                  sigSummary: sigSummaryOf(m),
                  status: m.status,
                  isControlledSubstance: m.isControlledSubstance,
                  deaSchedule: m.deaSchedule,
                  signedAt: m.signedAt,
                  isSudTreatment: m.isSudTreatment,
                })),
              } satisfies PatientMedicationListRenderPayload),
        // Skip the M39 seam call entirely when nothing on the resolved set needs it (the render-consumer
        // .ts "only when flagged" optimization).
        sudConsentPresent: medications?.some((m) => m.isSudTreatment)
          ? await resolveConsentPresent({
              organizationId: event.organizationId,
              patientId: payload.patientId,
            })
          : false,
      };

      const action = decideMedicationListRender(payload, facts);
      switch (action.kind) {
        case "idempotent_skip":
          return; // structurally unreachable here (the early-return above already handled it); kept so
        // the decider's own type stays exhaustive and testable in isolation from this wiring
        case "medications_unresolved":
          deps.onRefusal?.({
            eventType: event.eventType,
            organizationId: event.organizationId,
            patientId: action.patientId,
            detail: "MedicationOrderProvider seam unavailable",
          });
          // Retry-then-DLQ (§7.2): never render a list that silently omits every medication.
          throw new MalformedMedicationListRequestError(
            `MedicationOrderProvider seam unavailable for patient ${action.patientId}`,
          );
        case "render": {
          const { variant } = action;
          // NOTE (reported, not fixed here): `DocumentRenderer.render()` always inserts under the
          // TEMPLATE'S OWN `descriptor.retentionClass` (renderer.ts's `upsertRenderedDocument` call) — it
          // takes no retention-class parameter at all, so `action.retentionClass`
          // (`variant.retentionClassOverride`, the §7.16 `compliance_42cfr_part2` SUD override) is not
          // threaded into the persisted row. This is the render-consumer.ts pipeline's own EXISTING
          // behaviour (its `case "render"` destructures only `render`, never `action.retentionClass`
          // either) — matched here for consistency, not newly introduced. The row-level redaction (the
          // actual disclosure protection — no plaintext SUD-treatment drug name reaches the rendered
          // bytes) is unaffected by this gap.
          await renderer().render({ orgId: event.organizationId }, variant.templateKey, {
            ...variant.content,
            aggregateId: action.patientId,
            patientId: action.patientId,
            ...(variant.sudRedacted ? { sudRedacted: true } : {}),
            // F-168 (#248) — atomic with the version write via `document_version.source_event_id`.
            sourceEventId: event.id,
          });
          const written = await deps.store.documentVersionForSourceEvent({
            sourceEventId: event.id,
            organizationId: event.organizationId,
          });
          if (written) {
            await announce({
              organizationId: event.organizationId,
              patientId: action.patientId,
              row: written,
            });
          }
          return;
        }
      }
    },
  };
}
