// apps/backend/src/modules/36-messaging/ai/unavailable-ai-port.ts - WP 6.5 (ADR-0095 section 5.3): the production default. Until a deployment binds
// M32's governed pipeline (a backend with a recorded BAA and ZDR, an opted-in tenant, a capability past stage 4), every call answers "AI unavailable".
// There is no fallback to any other vendor or path, ever.
import type { MessagingAiPort } from "@chartwarden/types";

export const UNAVAILABLE_AI_PORT: MessagingAiPort = {
  summarize: async () => ({ available: false }),
  draftReply: async () => ({ available: false }),
  recordOutcome: async () => "not_found",
};
