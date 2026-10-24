// M36 WP 6.5 (ADR-0095) - AI thread summaries and reply drafts through M32.
//
// DATA ONLY. This file is the contract between M36 (which loads, minimises and renders) and M32 (which governs and dispatches). It holds no
// behaviour that could send a message, create a task, place an order or write a chart record: the port below returns text and records one
// human decision, nothing else (ADR-0095 section 4). M36 and M32 both import it from here, so neither module gains a dependency edge on the other.

/** Tenant flag (absent = off), checked in addition to M32's own `ai.full`, tenant opt-in and kill-switch gates. */
export const MESSAGING_AI_FLAG_KEY = "messaging.ai.enabled" as const;

/** Permission to ask for a summary or a draft. The caller must ALSO be a current member of the channel (checked at call time). */
export const MESSAGING_AI_USE_PERMISSION = "messaging.ai.use" as const;

/** M32 capability keys (ADR-0095 section 5.4). Registered PROPOSED / High risk: they serve nothing until M32 stage 4. */
export const MESSAGING_AI_CAPABILITY_SUMMARIZE = "messaging_summarize" as const;
export const MESSAGING_AI_CAPABILITY_DRAFT_REPLY = "messaging_draft_reply" as const;

/** What a reader (and the model) sees in place of a message that is not sent to the model. */
export const MESSAGING_AI_WITHHELD_PLACEHOLDER = "[message withheld]" as const;

/** The patient token. Never a name, MRN, date of birth, address or phone number. */
export const MESSAGING_AI_PATIENT_TOKEN = "[PATIENT]" as const;

/** The label the panel carries (UI spec 6.5). */
export const MESSAGING_AI_SUMMARY_LABEL = "AI summary - draft - not verified" as const;
export const MESSAGING_AI_DRAFT_LABEL = "AI draft - edit before sending" as const;

/** Every number ADR-0095 names, in one place. Starting guesses, not measurements (ADR-0095 "Unverified"). */
export const MESSAGING_AI_LIMITS = {
  /** The window is the SMALLER of this many messages and this many days. */
  windowMaxMessages: 50,
  windowMaxDays: 14,
  /** Fewer included messages than this is "too little to summarise": the model is not called. */
  minMessagesToSummarise: 3,
  /** One message body is cut at this many characters before it is sent. */
  maxCharsPerMessage: 1_200,
  maxOutputTokensSummary: 600,
  maxOutputTokensDraft: 300,
  dispatchTimeoutMs: 8_000,
  /** Per user, per hour. */
  summariesPerUserPerHour: 10,
  draftsPerUserPerHour: 20,
  /** Per channel, per ten minutes (summaries only). */
  summariesPerChannelPerTenMinutes: 3,
  /** Output bounds: a longer answer is cut, not trusted. */
  maxPoints: 8,
  maxPointChars: 400,
  maxOpenQuestions: 4,
  maxQuestionChars: 300,
  maxDrafts: 2,
  maxDraftChars: 1_200,
  maxSourcesPerPoint: 6,
} as const;

/** The human decision recorded on the M32 ledger row (`ai_invocation.hitl_outcome`). */
export const MESSAGING_AI_OUTCOMES = ["accepted", "edited", "rejected"] as const;
export type MessagingAiOutcome = (typeof MESSAGING_AI_OUTCOMES)[number];

export const MESSAGING_AI_CONFIDENCES = ["high", "medium", "low"] as const;
export type MessagingAiConfidence = (typeof MESSAGING_AI_CONFIDENCES)[number];

// ── what the browser receives ─────────────────────────────────────────────────────────────────────────────────

export interface MessagingAiSource {
  /** 1-based position shown as [n]. */
  readonly n: number;
  /** Mapped back server-side from the opaque ref; always a message of THIS channel that was sent to the model. */
  readonly message_id: string;
  readonly sent_at: string;
}

export interface MessagingAiSummaryPoint {
  readonly text: string;
  readonly confidence: MessagingAiConfidence;
  readonly sources: readonly MessagingAiSource[];
}

export interface MessagingAiSummaryDto {
  readonly label: typeof MESSAGING_AI_SUMMARY_LABEL;
  readonly invocation_id: string | null;
  readonly invoked_at: string | null;
  /** `insufficient_context`: "too little to summarise" (the model said so, or fewer than the minimum were includable). */
  readonly status: "ok" | "insufficient_context";
  readonly points: readonly MessagingAiSummaryPoint[];
  readonly open_questions: readonly string[];
  /** Messages whose text was sent to the model. */
  readonly included_count: number;
  /** Deleted, redacted, held or unreadable messages: a bare count, never which or why. */
  readonly withheld_count: number;
  /** Hash of the included message ids: the browser can skip a call when nothing changed. */
  readonly input_hash: string;
}

export interface MessagingAiDraftDto {
  readonly label: typeof MESSAGING_AI_DRAFT_LABEL;
  readonly invocation_id: string;
  readonly invoked_at: string;
  /** Plain text for the composer. Never stored by M36, never sent by M36. */
  readonly drafts: readonly { readonly text: string }[];
  readonly included_count: number;
  readonly withheld_count: number;
}

export interface MessagingAiStatusDto {
  readonly enabled: boolean;
}

// ── the port M36 consumes and M32 implements ──────────────────────────────────────────────────────────────────
// Returns TEXT and records ONE human decision. There is deliberately no method, parameter or callback here that can send, order or write.

export interface MessagingAiRequest {
  readonly organizationId: string;
  readonly actorUserId: string;
  readonly channelId: string;
  /** The patient of a patient-scoped channel (drives M32's PHI indicator and disclosure accounting); null otherwise. */
  readonly patientId: string | null;
  /** What the call covered, so the ledger row can prove it. Ids and a count only. */
  readonly messageRange: {
    readonly firstMessageId: string;
    readonly lastMessageId: string;
    readonly count: number;
  };
  /** Already minimised and pseudonymised by M36. This is the ONLY message-derived data that reaches the model. */
  readonly promptText: string;
  /** JSON Schema the backend must constrain its answer to. */
  readonly responseSchema: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens: number;
  readonly dispatchTimeoutMs: number;
}

export type MessagingAiCompletion =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly invokedAt: string;
      readonly text: string;
    }
  /** Every refusal (flag, consent, kill switch, cap, no BAA backend, vendor error, timeout) collapses to this: the panel says "AI unavailable". */
  | { readonly available: false };

export interface MessagingAiOutcomeInput {
  readonly organizationId: string;
  readonly actorUserId: string;
  /** The ledger row must be a messaging call about THIS channel by THIS actor, or the outcome is refused. */
  readonly channelId: string;
  readonly invocationId: string;
  readonly invokedAt: string;
  readonly outcome: MessagingAiOutcome;
}

export interface MessagingAiPort {
  summarize(request: MessagingAiRequest): Promise<MessagingAiCompletion>;
  draftReply(request: MessagingAiRequest): Promise<MessagingAiCompletion>;
  /** `not_found` when the invocation is not this actor's messaging call (or its outcome is already final). */
  recordOutcome(input: MessagingAiOutcomeInput): Promise<"recorded" | "not_found">;
}

// ── the structured answers the model is constrained to ────────────────────────────────────────────────────────

export const MESSAGING_AI_SUMMARY_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["points", "openQuestions", "insufficientContext"],
  properties: {
    points: {
      type: "array",
      maxItems: MESSAGING_AI_LIMITS.maxPoints,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceMessageRefs", "confidence"],
        properties: {
          text: { type: "string", maxLength: MESSAGING_AI_LIMITS.maxPointChars },
          sourceMessageRefs: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: [...MESSAGING_AI_CONFIDENCES] },
        },
      },
    },
    openQuestions: {
      type: "array",
      maxItems: MESSAGING_AI_LIMITS.maxOpenQuestions,
      items: { type: "string", maxLength: MESSAGING_AI_LIMITS.maxQuestionChars },
    },
    insufficientContext: { type: "boolean" },
  },
};

export const MESSAGING_AI_DRAFT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  additionalProperties: false,
  required: ["drafts"],
  properties: {
    drafts: {
      type: "array",
      maxItems: MESSAGING_AI_LIMITS.maxDrafts,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string", maxLength: MESSAGING_AI_LIMITS.maxDraftChars } },
      },
    },
  },
};
