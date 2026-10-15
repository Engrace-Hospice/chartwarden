// Shared by the WP 3.4 task tests: one task row in the shape the API returns.
import type { TaskDto } from "@wardenx/types";

export const TASK_FIXTURE: TaskDto = {
  id: "t1",
  message_id: "m1",
  channel_id: "c1",
  patient_id: null,
  created_by: "u2",
  assignee_id: "u1",
  assignee_display_name: "Alex Nurse",
  created_by_display_name: "Sam Lead",
  due_at: null,
  status: "open",
  clinical_concern: false,
  source_kind: "message",
  closed_reason: null,
  needs_owner: false,
  overdue: false,
  created_at: "2026-10-14T08:00:00.000Z",
  updated_at: "2026-10-14T08:00:00.000Z",
  allowed_actions: ["accept", "complete", "cancel", "reassign"],
};
