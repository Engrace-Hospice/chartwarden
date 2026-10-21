// @chartwarden/messaging - the platform-floor message templates (M36 WP 2.8). Non-clinical only: scheduling, admin,
// logistics, confirmation, general. No clinical handoff content (SBAR is Phase 3).
//
// MIRROR: migration 1086_m36_message_template.sql seeds these same rows (ids, keys, text). The rows are plain data with
// no single quote in any text so a unit test can compare the two (template-seed-migration.test.ts); change both.
import type { PlatformTemplate } from "./template-model";

export const PLATFORM_MESSAGE_TEMPLATES: readonly PlatformTemplate[] = [
  {
    id: "7d1c6e00-3600-4a00-8000-000000000001",
    templateKey: "scheduling.running_late",
    category: "scheduling",
    title: "Running late",
    body: "I am running a little behind and will arrive later than planned. I will update you as soon as I have a new arrival time.",
    requiredPhrases: [],
  },
  {
    id: "7d1c6e00-3600-4a00-8000-000000000002",
    templateKey: "scheduling.reschedule_request",
    category: "scheduling",
    title: "Request to reschedule",
    body: "Can we move this visit to a different time? Please reply with a time that works for you.",
    requiredPhrases: [],
  },
  {
    id: "7d1c6e00-3600-4a00-8000-000000000003",
    templateKey: "administrative.documentation_reminder",
    category: "administrative",
    title: "Documentation reminder",
    body: "Friendly reminder: please complete your outstanding documentation by the end of the day.",
    requiredPhrases: [],
  },
  {
    id: "7d1c6e00-3600-4a00-8000-000000000004",
    templateKey: "logistics.delivery_requested",
    category: "logistics",
    title: "Supply delivery requested",
    body: "The supply delivery has been requested. I will confirm once it is on its way.",
    requiredPhrases: [],
  },
  {
    id: "7d1c6e00-3600-4a00-8000-000000000005",
    templateKey: "confirmation.received",
    category: "confirmation",
    title: "Message received",
    body: "Thanks, message received. I will follow up shortly.",
    requiredPhrases: [],
  },
  {
    id: "7d1c6e00-3600-4a00-8000-000000000006",
    templateKey: "general.after_hours_emergency",
    category: "general",
    title: "After hours and emergencies",
    body: "I am away from my messages right now. If this is an emergency, call 911. For urgent needs that are not an emergency, contact the on-call line.",
    requiredPhrases: ["call 911", "on-call line"],
  },
];
