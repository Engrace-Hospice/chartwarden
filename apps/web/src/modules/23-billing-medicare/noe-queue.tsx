// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the NOE QUEUE (R2, §5.1 #11, §10 PR-J).
// Notices of Election grouped by state, each with a §7.5 CountdownChip to its CMS 5-day filing window plus an
// in-window / at-risk / breached §6.6 window tier. Thin wrapper over the shared NoticeWindowQueue (NOE/NOTR
// are structurally identical). GET /api/v1/noe-records. Lantern WorkQueueLayout, tokens-only, §5.4 aria-live.
import type { JSX } from "react";
import { NOE_CONFIG, NoticeWindowQueue } from "./notice-window";

export function NoeQueue(): JSX.Element {
  return <NoticeWindowQueue config={NOE_CONFIG} />;
}
