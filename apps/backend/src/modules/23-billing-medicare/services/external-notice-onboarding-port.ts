import type { BillingDb } from "@chartwarden/billing";
// apps/backend/src/modules/23-billing-medicare/services/external-notice-onboarding-port.ts — M23's side of the platform notice seam
// (bootstrap/onboarding-notice-port.ts): a platform operator withdraws a tenant's "filed outside ChartWarden" NOE / NOTR record
// through the SAME rule the unit tests pin (`withdrawExternalNoticeFiling`), on the caller's transaction.
import type { DbClient } from "@chartwarden/db";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";
import type {
  OnboardingNoticePort,
  OnboardingNoticeView,
} from "../../../bootstrap/onboarding-notice-port";
import { withdrawExternalNoticeFiling } from "./external-notice-filing";

export function buildExternalNoticeOnboardingPort(): OnboardingNoticePort {
  return {
    async withdrawExternalFiling(tx, scope, input) {
      await assertTxScopedToOrg(tx as DbClient, scope.organizationId);
      const { notice, withdrawnFiledOn, withdrawnRecordedAt } = await withdrawExternalNoticeFiling(
        tx as unknown as BillingDb,
        {
          kind: input.kind,
          organizationId: scope.organizationId,
          noticeId: input.noticeId,
          expectedRecordedAt: input.expectedRecordedAt,
        },
      );
      const view: OnboardingNoticeView = {
        noticeKind: input.kind,
        noticeId: notice.id,
        state: notice.state,
        windowTargetAt: notice.windowTargetAt,
        windowBreachedAt: notice.windowBreachedAt ?? null,
        externalFiling: null,
      };
      return {
        resourceId: notice.id,
        view,
        detail: {
          noticeKind: input.kind,
          withdrawnFiledOn,
          withdrawnRecordedAt,
        },
      };
    },
  };
}
