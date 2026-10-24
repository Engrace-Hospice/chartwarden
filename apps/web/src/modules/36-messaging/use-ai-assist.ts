// M36 WP 6.5 (ADR-0095) - state for the AI summary panel. Everything generated lives HERE, in browser memory, and nowhere else: not in
// localStorage, not in a cache, not in the draft store. Closing the thread drops it. A draft reaches the composer only through `copyToDraft`,
// which the user clicks; nothing here sends a message.
import type {
  MessagingAiDraftDto,
  MessagingAiOutcome,
  MessagingAiSummaryDto,
} from "@chartwarden/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalApiClient } from "./use-handoffs-enabled";

const STATUS_PATH = "/api/v1/messaging/ai/status";
const SUMMARY_PATH = "/api/v1/messaging/channels/{id}/summaries";
const DRAFT_PATH = "/api/v1/messaging/channels/{id}/draft-replies";
const OUTCOME_PATH = "/api/v1/messaging/channels/{id}/ai-outcomes";

export type AiProblem = "unavailable" | "limited" | "refused" | "not_for_channel" | "error";

export type AiView =
  | { readonly phase: "idle" }
  | { readonly phase: "generating"; readonly kind: "summary" | "draft" }
  | { readonly phase: "summary"; readonly data: MessagingAiSummaryDto }
  | {
      readonly phase: "drafts";
      readonly data: MessagingAiDraftDto;
      readonly back: MessagingAiSummaryDto | null;
    }
  | { readonly phase: "problem"; readonly problem: AiProblem };

interface AiClient {
  GET(path: string): Promise<{ data?: { enabled?: boolean } }>;
  POST(
    path: string,
    init: { params: { path: { id: string } }; body?: Record<string, unknown> },
  ): Promise<{ data?: unknown; error?: unknown; response?: { status: number } }>;
}

/** The panel is absent unless the tenant flag AND the caller's permission say yes. Any failure reads as off. */
export function useAiEnabled(): boolean {
  const client = useOptionalApiClient();
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    if (!client) {
      setEnabled(false);
      return;
    }
    void Promise.resolve()
      .then(() => (client as unknown as AiClient).GET(STATUS_PATH))
      .then(
        (res) => live && setEnabled(res?.data?.enabled === true),
        () => live && setEnabled(false),
      );
    return () => {
      live = false;
    };
  }, [client]);
  return enabled;
}

function codeOf(error: unknown): string {
  const e = error as { code?: unknown; error?: { code?: unknown } } | null | undefined;
  const code = e?.error?.code ?? e?.code;
  return typeof code === "string" ? code : "";
}

function problemOf(status: number, error: unknown): AiProblem {
  const code = codeOf(error);
  if (status === 429) return "limited";
  if (code === "AI_OUTPUT_REFUSED") return "refused";
  if (code === "AI_NOT_AVAILABLE_FOR_CHANNEL") return "not_for_channel";
  if (status === 503 || code === "AI_UNAVAILABLE" || code === "AI_NOT_ENABLED")
    return "unavailable";
  return "error";
}

interface Copied {
  readonly text: string;
  readonly invocationId: string;
  readonly invokedAt: string;
}

export function useAiAssist(channelId: string, draft: string) {
  const client = useOptionalApiClient();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AiView>({ phase: "idle" });
  const generation = useRef(0);
  const copied = useRef<Copied | null>(null);
  const decided = useRef<Set<string>>(new Set());

  // A different conversation starts clean: nothing generated for one channel is shown in another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on channel change only
  useEffect(() => {
    generation.current += 1;
    copied.current = null;
    decided.current = new Set();
    setOpen(false);
    setView({ phase: "idle" });
  }, [channelId]);

  const record = useCallback(
    (invocationId: string, invokedAt: string, outcome: MessagingAiOutcome): void => {
      if (!client) return;
      void Promise.resolve()
        .then(() =>
          (client as unknown as AiClient).POST(OUTCOME_PATH, {
            params: { path: { id: channelId } },
            body: { invocation_id: invocationId, invoked_at: invokedAt, outcome },
          }),
        )
        .catch(() => undefined);
    },
    [client, channelId],
  );

  // The user edited what they copied: refine "accepted" to "edited" once. Clearing the box (it was sent) leaves "accepted".
  useEffect(() => {
    const c = copied.current;
    if (!c) return;
    if (draft === "") {
      copied.current = null;
    } else if (!draft.includes(c.text)) {
      copied.current = null;
      record(c.invocationId, c.invokedAt, "edited");
    }
  }, [draft, record]);

  const run = useCallback(
    async (kind: "summary" | "draft", back: MessagingAiSummaryDto | null): Promise<void> => {
      if (!client) return;
      const mine = ++generation.current;
      setView({ phase: "generating", kind });
      try {
        const res = await (client as unknown as AiClient).POST(
          kind === "summary" ? SUMMARY_PATH : DRAFT_PATH,
          {
            params: { path: { id: channelId } },
          },
        );
        if (mine !== generation.current) return;
        if (res.data) {
          setView(
            kind === "summary"
              ? { phase: "summary", data: res.data as MessagingAiSummaryDto }
              : { phase: "drafts", data: res.data as MessagingAiDraftDto, back },
          );
        } else {
          setView({ phase: "problem", problem: problemOf(res.response?.status ?? 0, res.error) });
        }
      } catch {
        if (mine === generation.current) setView({ phase: "problem", problem: "unavailable" });
      }
    },
    [client, channelId],
  );

  const settle = useCallback(
    (outcome: MessagingAiOutcome): void => {
      if (view.phase !== "summary" && view.phase !== "drafts") return;
      const id = view.data.invocation_id;
      if (!id || !view.data.invoked_at || decided.current.has(id)) return;
      decided.current.add(id);
      record(id, view.data.invoked_at, outcome);
    },
    [view, record],
  );

  return {
    open,
    view,
    /** Opening is the explicit click: it generates (unless a result is already in memory). */
    toggle: (): void => {
      if (open) {
        // Closing without copying anything is a rejection of what was shown.
        if (!copied.current) settle("rejected");
        setOpen(false);
        return;
      }
      setOpen(true);
      if (view.phase === "idle" || view.phase === "problem") void run("summary", null);
    },
    close: (): void => {
      if (!copied.current) settle("rejected");
      setOpen(false);
    },
    cancel: (): void => {
      generation.current += 1;
      setView({ phase: "idle" });
    },
    regenerate: (): void => {
      settle("rejected");
      void run("summary", null);
    },
    notUseful: (): void => {
      settle("rejected");
      setOpen(false);
    },
    draftReply: (): void => {
      void run("draft", view.phase === "summary" ? view.data : null);
    },
    backToSummary: (): void => {
      if (view.phase === "drafts" && view.back) setView({ phase: "summary", data: view.back });
      else void run("summary", null);
    },
    /** The ONLY way generated text reaches the composer; the caller supplies the setter and the user clicked. */
    copyToDraft: (text: string): void => {
      if (view.phase !== "summary" && view.phase !== "drafts") return;
      const id = view.data.invocation_id;
      if (!id || !view.data.invoked_at) return;
      copied.current = { text, invocationId: id, invokedAt: view.data.invoked_at };
      if (!decided.current.has(id)) {
        decided.current.add(id);
        record(id, view.data.invoked_at, "accepted");
      }
    },
  };
}
