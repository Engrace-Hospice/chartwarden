// Shared by the WP 3.5 handoff tests: a handoff and its items in the shape the API returns.
import type { HandoffDto, HandoffItemDto } from "@chartwarden/types";

export const ITEM_FIXTURE: HandoffItemDto = {
  id: "i1",
  patient_id: "p1",
  patient_display_name: "Ann B.",
  mrn_suffix: "1234",
  kind: "visit",
  ref_id: "r1",
  state: "pending",
  accountable_user_id: "u2",
  accountable_display_name: "Sam Lead",
  resolved_at: null,
  summary: { state: "ok", status: "scheduled", occurred_at: "2026-10-15T09:00:00.000Z" },
};

export const HANDOFF_FIXTURE: HandoffDto = {
  id: "h1",
  from_user_id: "u2",
  from_display_name: "Sam Lead",
  to_user_id: "u1",
  to_display_name: "Alex Nurse",
  state: "offered",
  offered_at: "2026-10-14T08:00:00.000Z",
  expires_at: "2099-10-14T12:00:00.000Z",
  accepted_at: null,
  closed_at: null,
  closed_reason: null,
  needs_attention: false,
  patient_count: 1,
  item_counts: { pending: 2, accepted: 0, declined: 0, expired: 0, cancelled: 0 },
  allowed_actions: ["accept", "decline"],
  items: [
    ITEM_FIXTURE,
    { ...ITEM_FIXTURE, id: "i2", kind: "patient", ref_id: "p1", summary: { state: "ok" } },
  ],
};
