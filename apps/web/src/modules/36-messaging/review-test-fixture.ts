// Shared by the WP 3.8 review-queue tests: one review item in the shape the API returns.
import type { ReviewItemDto } from "@wardenx/types";

export const REVIEW_FIXTURE: ReviewItemDto = {
  id: "r1",
  source: "patient_lifecycle",
  cause: "death",
  state: "open",
  resolution: null,
  resolution_reason: null,
  restricted: false,
  patient_id: "p1",
  patient_display_name: "Jane Doe",
  mrn_suffix: "1234",
  item_kind: "task",
  item_id: "t1",
  task: {
    status: "open",
    clinical_concern: true,
    needs_owner: false,
    due_at: null,
    assignee_user_id: "u2",
    assignee_display_name: "Alex Nurse",
    created_by_user_id: "u3",
    created_by_display_name: "Sam Lead",
    message_id: "m1",
    channel_id: "c1",
  },
  reassigned_to_user_id: null,
  reassigned_to_display_name: null,
  resolved_by_user_id: null,
  resolved_by_display_name: null,
  resolved_at: null,
  created_at: "2026-10-14T08:00:00.000Z",
  allowed_actions: ["reassign", "close"],
};

export const RESTRICTED_FIXTURE: ReviewItemDto = {
  ...REVIEW_FIXTURE,
  id: "r2",
  restricted: true,
  patient_id: null,
  patient_display_name: null,
  mrn_suffix: null,
  task: null,
  allowed_actions: [],
};
