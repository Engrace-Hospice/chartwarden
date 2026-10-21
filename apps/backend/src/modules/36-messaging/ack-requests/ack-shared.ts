// apps/backend/src/modules/36-messaging/ack-requests/ack-shared.ts - small helpers shared by the ack service and the ADR-0078 supervisor
// operations (kept apart so neither file grows past the maintainability ceiling).
import { NotFoundError, ChartWardenError } from "@wardenx/types";
import type { AckRow } from "./ack-types";

export const requestNotFound = (): NotFoundError => new NotFoundError("escalation");
export const assigneeInvalid = (): ChartWardenError =>
  new ChartWardenError("ACK_ASSIGNEE_INVALID", "Choose a colleague who can take this message.", 422);

/** A port that throws answers "no" (used where a wrong "yes" is the danger: choosing an assignee). */
export async function orElse<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

const WAITING = ["pending", "escalated", "failed_unreachable"] as const;
export const isWaiting = (s: AckRow["status"]): boolean =>
  (WAITING as readonly string[]).includes(s);
export const isOpen = (s: AckRow["status"]): boolean => isWaiting(s) || s === "acknowledged";
