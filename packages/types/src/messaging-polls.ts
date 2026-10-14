// WP 2.10 - polls in a messaging channel. NON-CLINICAL: a poll is a single-choice, named-vote question for staff
// ("lunch on Friday?"), never a clinical decision, a sign-off or an acknowledgement. Creation is refused in any
// channel that carries a patient link (see `pollBlockedChannelKinds` in the backend's poll-service-db.ts). The question is the
// message body; options are sealed at rest like a body. Everything here is shared by the API and the web client so
// the bounds and the plain-text rules are stated once.

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_QUESTION_LENGTH = 300;
export const POLL_MAX_OPTION_LENGTH = 100;

/**
 * Channel kinds whose subject is a patient or a patient's bereavement plan: no polls there. The web reads this list;
 * the backend derives the same set from CHANNEL_KIND_DESCRIPTORS and a backend test pins the two together.
 */
export const POLL_BLOCKED_CHANNEL_KINDS = ["care_team", "bereavement"] as const;

/** An option as a reader sees it. `voteCount` is exact; the voters are listed only by the poll detail read. */
export interface PollOptionView {
  readonly optionId: string;
  readonly label: string;
  readonly voteCount: number;
}

/** A poll as it rides on a message. `myOptionId` is the viewer's own vote (null = not voted). */
export interface PollView {
  readonly pollId: string;
  readonly closed: boolean;
  readonly closedAt: string | null;
  readonly totalVotes: number;
  readonly myOptionId: string | null;
  /**
   * True when this viewer is the poll's author and it is open. Message reads cannot cheaply know whether the viewer
   * is a channel manager, so a manager is NOT reflected here: the close route still lets a manager close (403 for
   * anyone else), but the web card offers Close to the author only.
   */
  readonly canClose: boolean;
  readonly options: readonly PollOptionView[];
}

export interface PollVoterView {
  readonly userId: string;
  readonly displayName: string;
  readonly votedAt: string;
}

/** The poll detail read: the poll plus who voted for each option (votes are NAMED by design). */
export interface PollDetailView extends PollView {
  readonly voters: Readonly<Record<string, readonly PollVoterView[]>>;
}

/** Control characters (incl. line breaks and tabs): a poll label is one line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the purpose
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
/** Zero-width and bidirectional control characters: invisible, so they could spoof a label or hide a duplicate. */
const INVISIBLE_FORMATTING = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** Anything that reads as an HTML tag or comment. Labels render as text, but no markup is stored at all. */
const MARKUP = /<\/?[a-z!?][^>]*>/i;

/** NFC, control characters to a space, runs of whitespace collapsed, trimmed. Plain text out, never markup. */
export function normalisePollText(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(INVISIBLE_FORMATTING, "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type PollTextProblem = "blank" | "too_long" | "markup";

/** Why a normalised label cannot be used, or null. `max` is the length bound for this field. */
export function pollTextProblem(normalised: string, max: number): PollTextProblem | null {
  if (normalised.length === 0) return "blank";
  if (normalised.length > max) return "too_long";
  if (MARKUP.test(normalised)) return "markup";
  return null;
}

export type PollInputProblem =
  | { readonly field: "question"; readonly problem: PollTextProblem }
  | { readonly field: "options"; readonly problem: "count" | "duplicate" }
  | { readonly field: `options.${number}`; readonly problem: PollTextProblem };

/** Normalise and check a poll draft. `ok` carries the cleaned values the server stores. */
export function checkPollInput(input: {
  readonly question: string;
  readonly options: readonly string[];
}):
  | { readonly ok: true; readonly question: string; readonly options: readonly string[] }
  | { readonly ok: false; readonly problems: readonly PollInputProblem[] } {
  const question = normalisePollText(input.question);
  const options = input.options.map(normalisePollText);
  const problems: PollInputProblem[] = [];
  const questionProblem = pollTextProblem(question, POLL_MAX_QUESTION_LENGTH);
  if (questionProblem) problems.push({ field: "question", problem: questionProblem });
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    problems.push({ field: "options", problem: "count" });
  }
  options.forEach((label, index) => {
    const problem = pollTextProblem(label, POLL_MAX_OPTION_LENGTH);
    if (problem) problems.push({ field: `options.${index}`, problem });
  });
  if (new Set(options.map((label) => label.toLocaleLowerCase())).size !== options.length) {
    problems.push({ field: "options", problem: "duplicate" });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, question, options };
}
