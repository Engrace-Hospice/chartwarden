// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the NOTR DETAIL (R2, §5.1 #14, §10 PR-J).
// Single Notice of Termination / Revocation: filing-window aside (§7.5 CountdownChip + §6.6 window tier), full
// field detail, and the submit + cancel actions (POST /api/v1/notr-records/:id/submit | /cancel, If-Match + M2
// step-up). Parallel to the NOE detail — a thin wrapper over the shared NoticeWindowDetail. Lantern
// DetailPageLayout, tokens-only, §5.4 aria-live countdown.
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { NOTR_CONFIG, NoticeWindowDetail } from "./notice-window";

export function NotrDetail(): JSX.Element {
  const { notrId } = useParams<{ notrId: string }>();
  return <NoticeWindowDetail config={NOTR_CONFIG} id={notrId ?? ""} />;
}
