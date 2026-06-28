// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the NOTR QUEUE (R2, §5.1 #13, §10 PR-J).
// Notices of Termination / Revocation grouped by state, each with a §7.5 CountdownChip to its filing window plus
// an in-window / at-risk / breached §6.6 window tier. Parallel to the NOE queue — a thin wrapper over the shared
// NoticeWindowQueue. GET /api/v1/notr-records. Lantern WorkQueueLayout, tokens-only, §5.4 aria-live countdown.
import type { JSX } from "react";
import { NOTR_CONFIG, NoticeWindowQueue } from "./notice-window";

export function NotrQueue(): JSX.Element {
  return <NoticeWindowQueue config={NOTR_CONFIG} />;
}
