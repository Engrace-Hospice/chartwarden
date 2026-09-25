export type MedicationWorkspaceStatus =
  | "all" | "needs_attention" | "active" | "draft" | "pending_signature"
  | "verbal_pending" | "discontinued" | "completed";

export const ATTENTION_STATUSES = ["verbal_pending", "nack_received", "transmission_failed", "expired_unsigned"] as const;
export const WORKSPACE_KPIS = [["all", "All"], ["draft", "Draft"], ["pending_signature", "Pending signature"], ["active", "Active"], ["needs_attention", "Needs attention"]] as const;

export function workspaceStatus(value: string | null): MedicationWorkspaceStatus {
  return ["all", "needs_attention", "active", "draft", "pending_signature", "verbal_pending", "discontinued", "completed"].includes(value ?? "")
    ? value as MedicationWorkspaceStatus : "all";
}
export function workspaceCount(status: typeof WORKSPACE_KPIS[number][0], counts: Record<string, number>): number {
  if (status === "all") return Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (status === "needs_attention") return ATTENTION_STATUSES.reduce((sum, value) => sum + (counts[value] ?? 0), 0);
  return counts[status] ?? 0;
}
