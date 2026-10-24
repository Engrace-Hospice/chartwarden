// apps/backend/src/modules/36-messaging/ai/fake-ai-port.ts - a deterministic MessagingAiPort for TESTS. It never touches the network, a vendor
// or a database: it records exactly what it was handed (the disclosure under test) and answers from a script.
import type {
  MessagingAiCompletion,
  MessagingAiOutcomeInput,
  MessagingAiPort,
  MessagingAiRequest,
} from "@chartwarden/types";

export interface FakeAiPort extends MessagingAiPort {
  readonly requests: MessagingAiRequest[];
  readonly outcomes: MessagingAiOutcomeInput[];
  /** Queue the next answers (consumed in order; the last repeats). */
  script(...answers: (string | null)[]): void;
}

export function createFakeAiPort(): FakeAiPort {
  const requests: MessagingAiRequest[] = [];
  const outcomes: MessagingAiOutcomeInput[] = [];
  let answers: (string | null)[] = [];
  let n = 0;
  const next = (request: MessagingAiRequest): MessagingAiCompletion => {
    requests.push(request);
    const answer = answers.length > 1 ? (answers.shift() as string | null) : (answers[0] ?? null);
    n += 1;
    return answer === null
      ? { available: false }
      : {
          available: true,
          invocationId: `inv-${n}`,
          invokedAt: "2026-10-23T12:00:00.000Z",
          text: answer,
        };
  };
  return {
    requests,
    outcomes,
    script: (...a) => {
      answers = [...a];
    },
    summarize: async (r) => next(r),
    draftReply: async (r) => next(r),
    recordOutcome: async (o) => {
      outcomes.push(o);
      return "recorded";
    },
  };
}
