// M36 ADR-0107 (PROPOSED) - group tags in messages: `@role`, `@care-team`, `@on-call`. A tag is a mention node whose kind is one of the three
// below; the server resolves it to people at send (inside the channel only) and freezes them. Behind the tenant flag `messaging.group_tags`
// (absent = off). Importers: the rich-body schema, the M36 send path, the mention candidate list, the route schemas.
import type { OnCallDirectoryRole } from "./messaging-oncall";

/** Tenant flag (absent = off). Off: group kinds are refused on write (422) and absent from the candidate list. */
export const GROUP_TAGS_FLAG_KEY = "messaging.group_tags";

export const GROUP_TAG_KINDS = ["role", "team", "on_call"] as const;
export type GroupTagKind = (typeof GROUP_TAG_KINDS)[number];

/** Every reference kind a message can carry (the CHECK on message_entity_reference.reference_kind lists exactly these). */
export const MENTION_KINDS = ["staff", "patient", ...GROUP_TAG_KINDS] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export const isGroupTagKind = (kind: string): kind is GroupTagKind =>
  (GROUP_TAG_KINDS as readonly string[]).includes(kind);

/** A tag that resolves to more people than this is refused, never truncated. */
export const GROUP_TAG_MAX_RECIPIENTS = 50;
/** Group tags (counted by reference) in one message. */
export const GROUP_TAG_MAX_PER_MESSAGE = 3;

/** The team tag's fixed label. */
export const GROUP_TAG_TEAM_LABEL = "Care team";

/** `on_call` has no entity of its own: one fixed well-known uuid per directory role, so the closed schema keeps a uuid `entityId`. */
export const ON_CALL_TAG_ENTITY_IDS: Readonly<Record<OnCallDirectoryRole, string>> = {
  rn: "00000000-0000-4000-8000-0000000000a1",
  physician: "00000000-0000-4000-8000-0000000000a2",
};
export const ON_CALL_TAG_LABELS: Readonly<Record<OnCallDirectoryRole, string>> = {
  rn: "On-call RN",
  physician: "On-call physician",
};

/** The directory role an `on_call` tag entity id stands for, or null. */
export function onCallRoleForEntityId(entityId: string): OnCallDirectoryRole | null {
  const id = entityId.toLowerCase();
  const hit = (Object.entries(ON_CALL_TAG_ENTITY_IDS) as [OnCallDirectoryRole, string][]).find(
    ([, value]) => value === id,
  );
  return hit ? hit[0] : null;
}

/** Typed refusals (HTTP 422). Messages name the rule, never a person. */
export const GROUP_TAG_ERROR_CODES = {
  disabled: "GROUP_TAGS_DISABLED",
  invalid: "GROUP_TAG_INVALID",
  empty: "GROUP_TAG_EMPTY",
  tooMany: "GROUP_TAG_TOO_MANY",
  onCallUnresolved: "GROUP_TAG_ON_CALL_UNRESOLVED",
} as const;
