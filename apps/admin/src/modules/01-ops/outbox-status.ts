// apps/admin/src/modules/01-ops — the outbox_event status set and its pill tone, shared by the list and the drawer.
export type OutboxStatus = "pending" | "dispatching" | "dispatched" | "failed";

export function outboxStatusTone(
  status: OutboxStatus,
): "success" | "progress" | "warning" | "error" {
  if (status === "dispatched") return "success";
  if (status === "dispatching") return "progress";
  if (status === "failed") return "error";
  return "warning";
}
