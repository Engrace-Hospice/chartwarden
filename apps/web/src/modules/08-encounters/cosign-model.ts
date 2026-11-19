// apps/web/src/modules/08-encounters — the words and rules of working a cosignature request, for a note and for an amendment of a signed
// note (ADR-0114 VN-D30, S1 PR E4). No I/O. The server decides every state and every refusal; this says in words where a request stands, which
// step its state allows (the §2.4 graph), who the screen offers the step to, and how a queue entry is told apart, keyed and opened.
import type { StatusTone } from "@chartwarden/ui";
import type { Session } from "../../shell/session";

/** What a cosignature request is about: the note's own, or the one a signed amending addendum opened. */
export type CosignSubjectKind = "note" | "addendum";

/** The three things a person does to a cosignature request. */
export type CosignStep = "acknowledge" | "sign" | "release";

/** The status of the cosignature request opened for an amendment, as `addenda[]` and each amendment version of `noteHistory` carry it. */
export type AmendmentCosignStatus = "not_required" | "pending" | "cosigned" | "released";

const AMENDMENT_COSIGN_WORDS: Readonly<Record<AmendmentCosignStatus, string | null>> = {
  not_required: null,
  pending: "Pending cosignature",
  cosigned: "Cosigned",
  released: "Released by a supervisor",
};

/** The amendment's cosignature in words; null when none was needed or the API sent none, so nothing is drawn. */
export function amendmentCosignWords(
  status: AmendmentCosignStatus | null | undefined,
): string | null {
  return status ? AMENDMENT_COSIGN_WORDS[status] : null;
}

const AMENDMENT_COSIGN_TONE: Readonly<Record<AmendmentCosignStatus, StatusTone>> = {
  not_required: "neutral",
  pending: "progress",
  cosigned: "success",
  released: "neutral",
};

export const amendmentCosignTone = (status: AmendmentCosignStatus): StatusTone =>
  AMENDMENT_COSIGN_TONE[status];

export interface CosignActions {
  readonly acknowledge: boolean;
  readonly sign: boolean;
  readonly release: boolean;
}

const NO_ACTIONS: CosignActions = { acknowledge: false, sign: false, release: false };

/**
 * The step a request's status allows, which is the server's §2.4 graph (the server still judges each step): a routed request is acknowledged,
 * then signed; an escalated one (24h) can still be signed, since the escalation alerts a supervisor and locks nothing; past the 48h cap only a
 * supervisor's release moves it; a released one is then signed by the RN. A status that is not known allows nothing.
 */
export function cosignActionsFor(status: string | null | undefined): CosignActions {
  switch (status) {
    case "routed":
      return { ...NO_ACTIONS, acknowledge: true };
    case "acknowledged":
    case "escalated":
    case "supervisor_released":
      return { ...NO_ACTIONS, sign: true };
    case "hard_cap_reached":
      return { ...NO_ACTIONS, release: true };
    default:
      return NO_ACTIONS;
  }
}

const REQUEST_WORDS: Readonly<Record<string, string>> = {
  routed: "Waiting for the cosigner to acknowledge it.",
  acknowledged: "Acknowledged. Waiting for the cosigner's signature.",
  escalated:
    "Escalated to a supervisor after 24 hours. Still waiting for the cosigner's signature.",
  hard_cap_reached:
    "Locked at the 48-hour cap. A supervisor must release it before the cosigner can sign.",
  supervisor_released: "Released by a supervisor. An RN still has to sign.",
};

/** Where an open request stands, for someone working it; null for a request that is signed, absent or in a state this does not know. */
export const cosignRequestWords = (status: string | null | undefined): string | null =>
  status ? (REQUEST_WORDS[status] ?? null) : null;

export interface CosignAuthors {
  /** The amendment's author, by membership id (what `addenda[].authoredByUserId` carries). */
  readonly addendumAuthorId: string;
  /** The signed note's author, by membership id; null when the screen was not told it. */
  readonly noteAuthorId: string | null;
}

export interface CosignAbility {
  /** Acknowledging and signing: cosign access, and the author of neither the note nor the amendment (§4.6 no self-cosign). */
  readonly acknowledgeAndSign: boolean;
  /** Releasing past the 48h cap: supervisor-release access. The server holds no author rule there. */
  readonly release: boolean;
  /** Why this viewer cannot acknowledge and sign, in words; null when they can, or when nothing is known about them. */
  readonly refusal: string | null;
}

const CANNOT_ACT: CosignAbility = { acknowledgeAndSign: false, release: false, refusal: null };
const WHO_CAN = "An RN who wrote neither the note nor this amendment has to cosign it.";

/**
 * Whether THIS viewer is offered the cosigner's steps on an amendment's request, from the session the screen already holds (the same
 * permission keys the routes enforce). It only decides what is shown: the server still judges every step, and a 403 is worded when it
 * comes. An unknown session or permission set fails closed and says nothing, since a refusal it cannot back would be a guess.
 */
export function cosignAbility(session: Session | null, authors: CosignAuthors): CosignAbility {
  const permissions = session?.permissions;
  if (!session || !permissions) return CANNOT_ACT;
  const release = permissions.includes("encounter.cosign_supervisor_release");
  const me = session.membershipId;
  if (me !== undefined && me === authors.addendumAuthorId) {
    return {
      ...CANNOT_ACT,
      release,
      refusal: `You wrote this amendment, so you cannot cosign it. ${WHO_CAN}`,
    };
  }
  if (me !== undefined && authors.noteAuthorId !== null && me === authors.noteAuthorId) {
    return {
      ...CANNOT_ACT,
      release,
      refusal: `You wrote the note this amendment belongs to, so you cannot cosign it. ${WHO_CAN}`,
    };
  }
  if (!permissions.includes("encounter.cosign")) {
    return { ...CANNOT_ACT, release, refusal: `Your role cannot cosign. ${WHO_CAN}` };
  }
  return { acknowledgeAndSign: true, release, refusal: null };
}

/** What a cosignature-queue entry says about the request it is for. */
export interface QueueCosign {
  readonly subject: CosignSubjectKind;
  readonly addendumId: string | null;
  readonly requestId: string | null;
  /** The request's own status (`routed`, `acknowledged`, ...), or null before any routing. */
  readonly status: string | null;
  /** When it was routed: the start of its own 12h/24h/48h clock. */
  readonly routedAt: string | null;
}

/** The slice of a cosignature-queue entry the queue's key, label and link are made from; `cosign` is absent on an older server. */
export interface QueueEntryRef {
  readonly id: string;
  readonly patientId: string;
  readonly cosign?: QueueCosign;
}

/** An entry is an amendment only when it says so and names the addendum; anything else (including no `cosign`) is the note. */
export function queueEntrySubject(entry: QueueEntryRef): CosignSubjectKind {
  return entry.cosign?.subject === "addendum" && entry.cosign.addendumId !== null
    ? "addendum"
    : "note";
}

export const queueEntrySubjectLabel = (entry: QueueEntryRef): "Note" | "Amendment" =>
  queueEntrySubject(entry) === "addendum" ? "Amendment" : "Note";

/** One encounter can hold a note's request and an amendment's at once: the amendment's own id keeps their rows apart. */
export function queueEntryKey(entry: QueueEntryRef): string {
  return queueEntrySubject(entry) === "addendum"
    ? `addendum:${entry.cosign?.addendumId}`
    : `note:${entry.id}`;
}

/** The id of an amendment's cosign panel on the encounter page: what a queue entry's link points at. */
export const amendmentCosignAnchor = (addendumId: string): string =>
  `addendum-cosign-${addendumId}`;

/** The encounter page; for an amendment, anchored to that addendum's cosign panel (an amendment's entry is its parent encounter). */
export function queueEntryHref(entry: QueueEntryRef): string {
  const page = `/patients/${entry.patientId}/encounters/${entry.id}`;
  return queueEntrySubject(entry) === "addendum" && entry.cosign?.addendumId
    ? `${page}#${amendmentCosignAnchor(entry.cosign.addendumId)}`
    : page;
}
