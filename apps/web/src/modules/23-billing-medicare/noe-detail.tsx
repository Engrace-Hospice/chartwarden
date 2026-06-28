// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the NOE DETAIL (R2, §5.1 #12, §10 PR-J).
// Single Notice of Election: filing-window aside (§7.5 CountdownChip + §6.6 window tier), full field detail, and
// the submit + cancel actions (POST /api/v1/noe-records/:id/submit | /cancel, If-Match + M2 step-up). Thin
// wrapper over the shared NoticeWindowDetail. Lantern DetailPageLayout, tokens-only, §5.4 aria-live countdown.
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { NOE_CONFIG, NoticeWindowDetail } from "./notice-window";

export function NoeDetail(): JSX.Element {
  const { noeId } = useParams<{ noeId: string }>();
  return <NoticeWindowDetail config={NOE_CONFIG} id={noeId ?? ""} />;
}
