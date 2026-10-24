// apps/backend/src/modules/23-billing-medicare/services/noe-notr-state-service.ts — the M23 NOE / NOTR
// fast-path state-transition SERVICE (spec §10 task 26 / §2.2 lines 224–260, D3).
//
// The notice analogue of the claim-state-service: it drives the PURE NOE / NOTR lifecycle reducers from
// `@chartwarden/billing` (`noeMachine.reduce` / `notrMachine.reduce`), persists each transition with the §2.5
// If-Match version check (`NoeRepository` / `NotrRepository` `transitionToState` → VERSION_CONFLICT → 412),
// and emits the canonical §4.10 `m23.noe.*` / `m23.notr.*` outbox event(s) through the injected
// {@link WriteOutboxPort} (`bindCallerModule("m23")`) — all inside ONE `withOrgContext` unit of work so
// Postgres RLS scopes every statement to `app.org_id` (the D2 outbox-only / transactional-outbox posture).
//
// Unlike the claim, the notice has NO separate state-history table (the §3.3 owned set carries none) — the
// audit trail is the append-only submission / acknowledgment rows + the outbox events. The notice fast path
// also has NO validation-failure submission gate (the submitter cron draws every READY row, §2.2); the only
// pure guard is the pre-submission `cancel` (election / terminating-event reversal), supplied by the caller.
//
// ENUM-CASE BOUNDARY: this service speaks the lowercase domain `NoticeState`; the repo maps to the UPPERCASE
// DB pgEnum at the boundary. NO PHI / NO MBI on any surface (D13). D13 AI-actor reject guard applies here too.
import { type NoticeState, noeMachine, notrMachine, repositories } from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, NotFoundError, ChartWardenError } from "@chartwarden/types";
import {
  type BillingDb,
  type BillingTx,
  type BillingWriteActor,
  type WriteOutboxPort,
  assertNotAiActor,
} from "./claim-state-service";

/** Which notice family a transition targets (selects the repo, machine, event prefix). */
export type NoticeKind = "noe" | "notr";

/** The §2.2 notice lifecycle events (NOE and NOTR share the identical alphabet). */
export type NoticeTransitionEvent =
  | "assemble"
  | "cancel"
  | "submit"
  | "ack_999_accepted"
  | "ack_999_rejected"
  | "ack_277ca_accepted"
  | "ack_277ca_rejected";

/** The columns a notice transition may set alongside `state` (control number / back-refs / window). */
export interface NoticeTransitionPatch {
  readonly payerControlNumber?: string;
  readonly latestSubmissionId?: string;
  readonly latestAcknowledgmentId?: string;
  readonly confirmationDocumentId?: string;
  /** A `YYYY-MM-DD` calendar date (the `window_breached_at` column is a SQL `date`, not a timestamp). */
  readonly windowBreachedAt?: string;
}

/** The variable fields the §4.10 notice-event schemas require (supplied by the caller). */
export interface NoticeEventExtra {
  readonly submissionId?: string;
  readonly acknowledgmentId?: string;
  readonly submittedAt?: string;
  readonly payerControlNumber?: string;
  readonly rejectionCodes?: readonly string[];
}

/** One NOE/NOTR lifecycle transition command. */
export interface NoticeTransitionInput {
  readonly kind: NoticeKind;
  readonly noticeId: string;
  /** The §2.5 If-Match version the transition is applied against (a stale value → 412). */
  readonly expectedVersion: number;
  readonly event: NoticeTransitionEvent;
  readonly patch?: NoticeTransitionPatch;
  readonly extra?: NoticeEventExtra;
  /**
   * For `cancel` only: whether the upstream m6 election (NOE) / terminating event (NOTR) has been reversed.
   * Fail-closed — the pure reducer rejects a `cancel` without this set to `true`.
   */
  readonly cancelReversed?: boolean;
}

/** The minimal shape both `NoeRecord` and `NotrRecord` expose for emission/result building. */
interface NoticeRecordShape {
  readonly id: string;
  readonly organizationId: string;
  readonly admissionId: string;
  readonly state: NoticeState;
  readonly version: number;
  /** F-144 (#248) — the chart-target patient the `m23.billing.document_render_requested` render needs
   * (§4.10). `noe_record.patient_id` / `notr_record.patient_id` are both NOT NULL, so this is never
   * fabricated — it is the same M5 identity the notice was already filed under. */
  readonly patientId: string;
}

export interface NoticeTransitionResult {
  readonly kind: NoticeKind;
  readonly noticeId: string;
  readonly fromState: NoticeState;
  readonly toState: NoticeState;
  readonly version: number;
  readonly emittedEvents: readonly string[];
}

/** The per-kind naming the §4.10 catalog uses (id key, control-number key, payer key, aggregate kind). */
function naming(kind: NoticeKind): {
  readonly prefix: string;
  readonly aggregateKind: string;
  readonly idKey: string;
  readonly ctrlKey: string;
  readonly payerKey: string;
} {
  return kind === "noe"
    ? {
        prefix: "m23.noe",
        aggregateKind: "noe_record",
        idKey: "noeId",
        ctrlKey: "noeControlNumber",
        payerKey: "payerNoeControlNumber",
      }
    : {
        prefix: "m23.notr",
        aggregateKind: "notr_record",
        idKey: "notrId",
        ctrlKey: "notrControlNumber",
        payerKey: "payerNotrControlNumber",
      };
}

/** Build the canonical §4.10 notice emission(s) for a transition (control number read off the record). */
function buildNoticeEmissions(
  kind: NoticeKind,
  event: NoticeTransitionEvent,
  rec: NoticeRecordShape,
  controlNumber: string,
  extra: NoticeEventExtra,
): readonly {
  eventName: string;
  aggregateKind: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}[] {
  const n = naming(kind);
  const base = { aggregateKind: n.aggregateKind, aggregateId: rec.id };
  switch (event) {
    case "assemble":
      return [
        {
          ...base,
          eventName: `${n.prefix}.submit_requested`,
          payload: {
            [n.idKey]: rec.id,
            submissionId: extra.submissionId,
            [n.ctrlKey]: controlNumber,
          },
        },
      ];
    case "submit":
      return [
        {
          ...base,
          eventName: `${n.prefix}.submitted`,
          payload: {
            [n.idKey]: rec.id,
            submissionId: extra.submissionId,
            submittedAt: extra.submittedAt,
          },
        },
        // F-144 (#248) — M23's §4.10 table names `m23.billing.document_render_requested` as the sole
        // M22 handshake for the notice confirmation receipt (`buildNoeConfirmationReceiptRequest`/
        // `buildNotrConfirmationReceiptRequest` in consumers/document-render.ts had no caller). Co-
        // emitted in the SAME transition as `.submitted`, never a separate consumer of that event.
        {
          ...base,
          eventName: "m23.billing.document_render_requested",
          payload: {
            kind: kind === "noe" ? "noe_confirmation_receipt" : "notr_confirmation_receipt",
            aggregateId: rec.id,
            payload: {
              patientId: rec.patientId,
              [n.ctrlKey]: controlNumber,
              submittedAt: extra.submittedAt,
            },
          },
        },
      ];
    case "ack_277ca_accepted":
      return [
        {
          ...base,
          eventName: `${n.prefix}.accepted`,
          payload: {
            [n.idKey]: rec.id,
            acknowledgmentId: extra.acknowledgmentId,
            [n.payerKey]: extra.payerControlNumber,
          },
        },
      ];
    case "ack_999_rejected":
    case "ack_277ca_rejected":
      return [
        {
          ...base,
          eventName: `${n.prefix}.rejected`,
          payload: { [n.idKey]: rec.id, rejectionCodes: [...(extra.rejectionCodes ?? [])] },
        },
      ];
    default:
      // `cancel` and the internal `ack_999_accepted` stage advance: no §4.10 event.
      return [];
  }
}

/** Map the generic notice patch onto the NOE repo's kind-specific patch (control-number key differs). */
function noePatch(p?: NoticeTransitionPatch): repositories.NoeTransitionPatch {
  if (!p) return {};
  return {
    ...(p.payerControlNumber !== undefined ? { payerNoeControlNumber: p.payerControlNumber } : {}),
    ...(p.latestSubmissionId !== undefined ? { latestSubmissionId: p.latestSubmissionId } : {}),
    ...(p.latestAcknowledgmentId !== undefined
      ? { latestAcknowledgmentId: p.latestAcknowledgmentId }
      : {}),
    ...(p.confirmationDocumentId !== undefined
      ? { confirmationDocumentId: p.confirmationDocumentId }
      : {}),
    ...(p.windowBreachedAt !== undefined ? { windowBreachedAt: p.windowBreachedAt } : {}),
  };
}

/** Map the generic notice patch onto the NOTR repo's kind-specific patch. */
function notrPatch(p?: NoticeTransitionPatch): repositories.NotrTransitionPatch {
  if (!p) return {};
  return {
    ...(p.payerControlNumber !== undefined ? { payerNotrControlNumber: p.payerControlNumber } : {}),
    ...(p.latestSubmissionId !== undefined ? { latestSubmissionId: p.latestSubmissionId } : {}),
    ...(p.latestAcknowledgmentId !== undefined
      ? { latestAcknowledgmentId: p.latestAcknowledgmentId }
      : {}),
    ...(p.confirmationDocumentId !== undefined
      ? { confirmationDocumentId: p.confirmationDocumentId }
      : {}),
    ...(p.windowBreachedAt !== undefined ? { windowBreachedAt: p.windowBreachedAt } : {}),
  };
}

/** Raise the structured error for a rejected pure-reducer step. */
function rejectReduce(error: string, event: NoticeTransitionEvent, from: NoticeState): never {
  if (error === "GUARD_FAILED") {
    throw new ChartWardenError(
      "GUARD_FAILED",
      `notice '${event}' requires the upstream election/terminating event to be reversed`,
      422,
    );
  }
  throw new ConflictError(`cannot '${event}' a notice in state '${from}'`);
}

export interface NoeNotrStateServicePorts {
  readonly outbox?: WriteOutboxPort;
  readonly now?: () => Date;
}

export interface NoeNotrStateService {
  /** Apply a notice transition in its OWN `withOrgContext` transaction (route / worker / consumer entry). */
  transition(
    actor: BillingWriteActor,
    input: NoticeTransitionInput,
  ): Promise<NoticeTransitionResult>;
  /** Apply a notice transition on a CALLER-PROVIDED tx (same-unit-of-work entry). */
  applyInTx(
    tx: BillingTx,
    actor: BillingWriteActor,
    input: NoticeTransitionInput,
  ): Promise<NoticeTransitionResult>;
  /**
   * The 5-day-window watchdog breach stamp (§2.2): version-checked patch of `window_breached_at` (no state
   * change) + the `${prefix}.window_breached` alert event. Drives the M23 window-watch cron worker.
   */
  recordWindowBreach(
    actor: BillingWriteActor,
    input: { kind: NoticeKind; noticeId: string; expectedVersion: number; breachedAt?: string },
  ): Promise<NoticeTransitionResult>;
  /** Emit the day-3 `${prefix}.window_warning` alert (no DB change); drives the window-watch cron worker. */
  emitWindowWarning(
    actor: BillingWriteActor,
    input: { kind: NoticeKind; noticeId: string; admissionId: string; daysIntoWindow: number },
  ): Promise<void>;
}

/** Build the Drizzle-backed {@link NoeNotrStateService}. `db` is the RLS-enforced primary client. */
export function buildNoeNotrStateService(
  db: BillingDb,
  ports: NoeNotrStateServicePorts = {},
): NoeNotrStateService {
  const now = ports.now ?? (() => new Date());

  const emit = async (
    tx: BillingTx,
    organizationId: string,
    e: {
      eventName: string;
      aggregateKind: string;
      aggregateId: string;
      payload: Record<string, unknown>;
    },
  ) => {
    if (ports.outbox) await ports.outbox.publish(tx, { ...e, organizationId });
  };

  const applyInTx = async (
    tx: BillingTx,
    actor: BillingWriteActor,
    input: NoticeTransitionInput,
  ): Promise<NoticeTransitionResult> => {
    assertNotAiActor(actor);

    if (input.kind === "noe") {
      const repo = new repositories.NoeRepository(tx);
      const rec = await repo.findById(input.noticeId);
      if (!rec || rec.organizationId !== actor.organizationId)
        throw new NotFoundError("noe record");
      const reduced = noeMachine.reduce(
        rec.state,
        input.event,
        input.event === "cancel" ? { electionReversed: input.cancelReversed } : {},
      );
      if (reduced.error) rejectReduce(reduced.error, input.event, rec.state);
      const versioned = await repo.transitionToState(
        rec.id,
        input.expectedVersion,
        reduced.state,
        noePatch(input.patch),
      );
      if (!versioned.ok) {
        throw new ChartWardenError(
          "VERSION_CONFLICT",
          `the NOE was modified concurrently (current version ${versioned.currentVersion ?? "unknown"})`,
          412,
        );
      }
      const updated = versioned.row;
      const emissions = buildNoticeEmissions(
        "noe",
        input.event,
        updated,
        updated.noeControlNumber,
        input.extra ?? {},
      );
      for (const e of emissions) await emit(tx, actor.organizationId, e);
      return {
        kind: "noe",
        noticeId: updated.id,
        fromState: rec.state,
        toState: updated.state,
        version: updated.version,
        emittedEvents: emissions.map((e) => e.eventName),
      };
    }

    const repo = new repositories.NotrRepository(tx);
    const rec = await repo.findById(input.noticeId);
    if (!rec || rec.organizationId !== actor.organizationId) throw new NotFoundError("notr record");
    const reduced = notrMachine.reduce(
      rec.state,
      input.event,
      input.event === "cancel" ? { terminatingEventReversed: input.cancelReversed } : {},
    );
    if (reduced.error) rejectReduce(reduced.error, input.event, rec.state);
    const versioned = await repo.transitionToState(
      rec.id,
      input.expectedVersion,
      reduced.state,
      notrPatch(input.patch),
    );
    if (!versioned.ok) {
      throw new ChartWardenError(
        "VERSION_CONFLICT",
        `the NOTR was modified concurrently (current version ${versioned.currentVersion ?? "unknown"})`,
        412,
      );
    }
    const updated = versioned.row;
    const emissions = buildNoticeEmissions(
      "notr",
      input.event,
      updated,
      updated.notrControlNumber,
      input.extra ?? {},
    );
    for (const e of emissions) await emit(tx, actor.organizationId, e);
    return {
      kind: "notr",
      noticeId: updated.id,
      fromState: rec.state,
      toState: updated.state,
      version: updated.version,
      emittedEvents: emissions.map((e) => e.eventName),
    };
  };

  const inOrgCtx = <T>(actor: BillingWriteActor, fn: (tx: BillingTx) => Promise<T>) =>
    withOrgContext<BillingTx, T>(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      fn,
    );

  return {
    applyInTx,
    transition(actor, input) {
      return inOrgCtx(actor, (tx) => applyInTx(tx, actor, input));
    },

    async recordWindowBreach(actor, input) {
      assertNotAiActor(actor);
      const breachedAt = input.breachedAt ?? now().toISOString();
      const n = naming(input.kind);
      return inOrgCtx(actor, async (tx) => {
        if (input.kind === "noe") {
          const repo = new repositories.NoeRepository(tx);
          const rec = await repo.findById(input.noticeId);
          if (!rec || rec.organizationId !== actor.organizationId)
            throw new NotFoundError("noe record");
          // Same-state patch of window_breached_at (a breach is not a machine transition).
          const versioned = await repo.transitionToState(rec.id, input.expectedVersion, rec.state, {
            windowBreachedAt: breachedAt.slice(0, 10),
          });
          if (!versioned.ok) {
            throw new ChartWardenError("VERSION_CONFLICT", "the NOE was modified concurrently", 412);
          }
          await emit(tx, actor.organizationId, {
            eventName: `${n.prefix}.window_breached`,
            aggregateKind: n.aggregateKind,
            aggregateId: rec.id,
            payload: { [n.idKey]: rec.id, admissionId: rec.admissionId, breachedAt },
          });
          return {
            kind: "noe" as const,
            noticeId: rec.id,
            fromState: rec.state,
            toState: rec.state,
            version: versioned.row.version,
            emittedEvents: [`${n.prefix}.window_breached`],
          };
        }
        const repo = new repositories.NotrRepository(tx);
        const rec = await repo.findById(input.noticeId);
        if (!rec || rec.organizationId !== actor.organizationId)
          throw new NotFoundError("notr record");
        const versioned = await repo.transitionToState(rec.id, input.expectedVersion, rec.state, {
          windowBreachedAt: breachedAt.slice(0, 10),
        });
        if (!versioned.ok) {
          throw new ChartWardenError("VERSION_CONFLICT", "the NOTR was modified concurrently", 412);
        }
        await emit(tx, actor.organizationId, {
          eventName: `${n.prefix}.window_breached`,
          aggregateKind: n.aggregateKind,
          aggregateId: rec.id,
          payload: { [n.idKey]: rec.id, admissionId: rec.admissionId, breachedAt },
        });
        return {
          kind: "notr" as const,
          noticeId: rec.id,
          fromState: rec.state,
          toState: rec.state,
          version: versioned.row.version,
          emittedEvents: [`${n.prefix}.window_breached`],
        };
      });
    },

    async emitWindowWarning(actor, input) {
      assertNotAiActor(actor);
      const n = naming(input.kind);
      await inOrgCtx(actor, async (tx) => {
        await emit(tx, actor.organizationId, {
          eventName: `${n.prefix}.window_warning`,
          aggregateKind: n.aggregateKind,
          aggregateId: input.noticeId,
          payload: {
            [n.idKey]: input.noticeId,
            admissionId: input.admissionId,
            daysIntoWindow: input.daysIntoWindow,
          },
        });
      });
    },
  };
}
