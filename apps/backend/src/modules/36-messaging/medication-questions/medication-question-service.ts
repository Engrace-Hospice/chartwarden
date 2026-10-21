// apps/backend/src/modules/36-messaging/medication-questions/medication-question-service.ts - WP 3.10: "Ask a nurse about a
// medication" (ADR-0067). One atomic, idempotent entry over three shipped things: the idempotent send (WP 1.2), the read-only
// medication link (WP 3.2) and the communication task (WP 3.4). The message, its optional link and the nurse's task commit
// in ONE transaction (the send core's `inTransaction` hook), so a crash leaves nothing half-made.
//
// This is never an order path. It imports nothing from M11/M12, reads no order or prescribing permission, and never inspects
// the question text: the text goes only into buildMedicationQuestionBody and from there into the sealed message.
import {
  type MessagingRouteService,
  type ValidatedClinicalLinkInput,
  buildMedicationQuestionBody,
  derivePatient,
  resolveMedicationQuestionAssignee,
} from "@chartwarden/messaging";
import {
  MEDICATION_QUESTION_COLLEAGUE_CAP,
  type MedicationQuestionOptions,
  type MedicationQuestionPerson,
  type MedicationQuestionResponse,
  NotFoundError,
  type RichBody,
  ChartWardenError,
} from "@chartwarden/types";
import { linkNotAvailable } from "../clinical-link/clinical-link-service";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import { resolveRichWrite } from "../rich-body-codec";
import { publishTaskEvent } from "../tasks/task-events";
import { taskRowToDto } from "../tasks/task-service";
import type { TaskRow, TaskStore } from "../tasks/task-store-db";
import { publishMedicationQuestionUnrouted } from "./medication-question-events";

export interface MedicationQuestionActorRef {
  readonly orgId: string;
  readonly userId: string;
}

export interface MedicationQuestionAsk {
  readonly channelId: string;
  readonly text: string;
  readonly medicationId?: string | undefined;
  readonly assigneeUserId?: string | undefined;
  readonly allowUnrouted: boolean;
  readonly clientMessageId: string;
  readonly correlationId?: string | undefined;
}

/** Request-scoped: authorises the link node(s) exactly as a normal send does (validateRichBodyLinks). */
export type ValidateLinks = (richBody: RichBody) => Promise<readonly ValidatedClinicalLinkInput[]>;

export interface ChannelFacts {
  readonly kind: string;
  readonly subjectId: string | null;
}

export interface MedicationQuestionServiceDeps {
  /** The flag `messaging.medication_questions` AND `messaging.tasks`. A throw reads as off. */
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  /** The flag `messaging.clinical_links`: whether the dialog may offer a medication to link. */
  readonly linksEnabled: (orgId: string) => Promise<boolean>;
  readonly outbox: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
    sendMessage: MessagingRouteService["sendMessage"];
  };
  readonly channelFacts: (orgId: string, channelId: string) => Promise<ChannelFacts | null>;
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly primaryRn: (orgId: string, patientId: string) => Promise<string | null>;
  /** recipientEligible for this patient (active, messaging + patient read, Part 2 gate). A throw reads as ineligible. */
  readonly isEligible: (orgId: string, userId: string, patientId: string) => Promise<boolean>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly taskStore: TaskStore;
  readonly now?: () => Date;
}

export interface MedicationQuestionService {
  ask(
    actor: MedicationQuestionActorRef,
    a: MedicationQuestionAsk,
    validateLinks: ValidateLinks,
  ): Promise<MedicationQuestionResponse>;
  options(actor: MedicationQuestionActorRef, channelId: string): Promise<MedicationQuestionOptions>;
}

const channelNotFound = (): NotFoundError => new NotFoundError("channel");
const typed = (code: string, message: string): ChartWardenError => new ChartWardenError(code, message, 422);

/** A port that throws answers "no": a seam outage must never route a question to a guess. */
async function orElse<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

export function createMedicationQuestionService(
  deps: MedicationQuestionServiceDeps,
): MedicationQuestionService {
  const clock = deps.now ?? (() => new Date());

  /** Eligible = recipientEligible for the patient AND able to view the channel (which carries the Part 2 gate). */
  const eligibleFor = (orgId: string, channelId: string, patientId: string) => (userId: string) =>
    orElse(
      async () =>
        (await deps.messaging.canViewChannel(orgId, userId, channelId)) &&
        (await deps.isEligible(orgId, userId, patientId)),
      false,
    );

  async function patientChannel(
    orgId: string,
    channelId: string,
  ): Promise<{ patientId: string | null }> {
    const facts = await deps.channelFacts(orgId, channelId);
    if (!facts) throw channelNotFound();
    const patientId =
      facts.kind === "care_team" ? derivePatient(facts.kind, facts.subjectId) : null;
    return { patientId };
  }

  async function visibleChannel(actor: MedicationQuestionActorRef, channelId: string) {
    if (!(await deps.isEnabled(actor.orgId).catch(() => false))) throw channelNotFound();
    if (!(await deps.messaging.canViewChannel(actor.orgId, actor.userId, channelId))) {
      throw channelNotFound();
    }
  }

  async function person(orgId: string, userId: string): Promise<MedicationQuestionPerson> {
    return {
      user_id: userId,
      display_name: await orElse(() => deps.displayName(orgId, userId), null),
    };
  }

  async function taskDto(row: TaskRow, viewerId: string) {
    const names = new Map<string, string | null>();
    for (const id of new Set([row.assigneeId, row.createdBy])) {
      names.set(id, await orElse(() => deps.displayName(row.organizationId, id), null));
    }
    return taskRowToDto(row, viewerId, names, clock());
  }

  return {
    async ask(actor, a, validateLinks) {
      await visibleChannel(actor, a.channelId);
      const { patientId } = await patientChannel(actor.orgId, a.channelId);
      if (!patientId) {
        throw typed(
          "MEDICATION_QUESTION_NOT_PATIENT_CHANNEL",
          "a medication question needs a patient care-team conversation",
        );
      }
      const assignee = await resolveMedicationQuestionAssignee({
        chosen: a.assigneeUserId ?? null,
        primaryRn: await orElse(() => deps.primaryRn(actor.orgId, patientId), null),
        careTeam: await orElse(() => deps.careTeamMembers(actor.orgId, patientId), []),
        callerId: actor.userId,
        isEligible: eligibleFor(actor.orgId, a.channelId, patientId),
      });
      if (assignee.kind === "invalid") {
        throw typed(
          "MEDICATION_QUESTION_ASSIGNEE_INVALID",
          "that colleague cannot take this question",
        );
      }
      if (assignee.kind === "unrouted" && !a.allowUnrouted) {
        throw typed("MEDICATION_QUESTION_NO_NURSE", "no nurse is available for this patient");
      }
      // Same authorisation as any send: a link the caller may not make fails here, before anything is written.
      const rich = resolveRichWrite({
        bodyDoc: buildMedicationQuestionBody(a.text, a.medicationId ?? null),
      });
      if (!rich) throw typed("VALIDATION_FAILED", "the question could not be built");
      const clinicalLinks = await validateLinks(rich.richBody);
      // The route authorises the caller, not the pairing: a medication of ANOTHER patient must not ride in this
      // patient's question. Same single refusal as any unavailable link (nothing says the record exists).
      if (clinicalLinks.some((link) => link.patientId?.toLowerCase() !== patientId.toLowerCase())) {
        throw linkNotAvailable();
      }

      // Written by the hook (inside the send transaction), read after it commits.
      const outcome: { hookRan: boolean; row: TaskRow | null; isNew: boolean } = {
        hookRan: false,
        row: null,
        isNew: false,
      };
      const sent = await deps.messaging.sendMessage(actor.orgId, {
        channelId: a.channelId,
        authorUserId: actor.userId,
        body: rich.plainText,
        bodyKind: "rich",
        richBody: rich.richBody,
        clientMessageId: a.clientMessageId,
        ...(a.correlationId ? { correlationId: a.correlationId } : {}),
        references: rich.references,
        clinicalLinks,
        inTransaction: async (tx, { messageId }) => {
          outcome.hookRan = true;
          const at = clock();
          if (assignee.kind === "unrouted") {
            await publishMedicationQuestionUnrouted(deps.outbox, tx, {
              orgId: actor.orgId,
              channelId: a.channelId,
              messageId,
              askedByUserId: actor.userId,
              reason: "no_nurse",
              at,
            });
            return;
          }
          const r = await deps.taskStore.createOrGetActive(tx as Tx, {
            orgId: actor.orgId,
            messageId,
            channelId: a.channelId,
            patientId,
            createdBy: actor.userId,
            assigneeId: assignee.userId,
            dueAt: null,
            clinicalConcern: true,
            sourceKind: "medication_question",
          });
          outcome.row = r.task;
          outcome.isNew = r.created;
          if (r.created) {
            await publishTaskEvent(deps.outbox, tx, {
              kind: "created",
              orgId: actor.orgId,
              taskId: r.task.id,
              messageId,
              channelId: a.channelId,
              assigneeUserId: assignee.userId,
              createdByUserId: actor.userId,
              at,
            });
          }
        },
      });

      // A replay (the hook did not run) returns the task stored for this message and asker, and writes nothing.
      const row = outcome.hookRan
        ? outcome.row
        : await deps.taskStore.findMedicationQuestion(actor.orgId, sent.messageId, actor.userId);
      return {
        message_id: sent.messageId,
        channel_id: sent.channelId,
        patient_id: patientId,
        routed: row !== null,
        task: row ? await taskDto(row, actor.userId) : null,
        // `created` = this call wrote the message (the hook ran): a fresh unrouted send counts, a replay does not.
        created: outcome.hookRan && (assignee.kind === "unrouted" || outcome.isNew),
      };
    },

    async options(actor, channelId) {
      if (!(await deps.isEnabled(actor.orgId).catch(() => false))) return { enabled: false };
      await visibleChannel(actor, channelId);
      const linksEnabled = await orElse(() => deps.linksEnabled(actor.orgId), false);
      const { patientId } = await patientChannel(actor.orgId, channelId);
      if (!patientId) {
        return {
          enabled: true,
          patient_linked: false,
          patient_id: null,
          nurse: null,
          colleagues: [],
          links_enabled: linksEnabled,
        };
      }
      const eligible = eligibleFor(actor.orgId, channelId, patientId);
      const rnId = await orElse(() => deps.primaryRn(actor.orgId, patientId), null);
      const nurse =
        rnId && rnId !== actor.userId && (await eligible(rnId))
          ? await person(actor.orgId, rnId)
          : null;
      const members = [...(await orElse(() => deps.careTeamMembers(actor.orgId, patientId), []))]
        .filter((id, i, all) => id !== actor.userId && all.indexOf(id) === i)
        .sort();
      const colleagues: MedicationQuestionPerson[] = [];
      for (const id of members) {
        if (colleagues.length >= MEDICATION_QUESTION_COLLEAGUE_CAP) break;
        if (await eligible(id)) colleagues.push(await person(actor.orgId, id));
      }
      colleagues.sort(
        (x, y) =>
          (x.display_name ?? "").localeCompare(y.display_name ?? "") ||
          x.user_id.localeCompare(y.user_id),
      );
      return {
        enabled: true,
        patient_linked: true,
        patient_id: patientId,
        nurse,
        colleagues,
        links_enabled: linksEnabled,
      };
    },
  };
}
