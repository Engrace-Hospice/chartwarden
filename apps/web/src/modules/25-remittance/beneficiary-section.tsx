// apps/web/src/modules/25-remittance — the claim-keyed beneficiary + representative sections (milestone 13a), mounted beside
// the case timeline. Each part appears only for a person who holds its read key; the server stays the enforcer.
import type { JSX } from "react";
import { useSession } from "../../shell/session";
import { BeneficiaryAppealPanel } from "./beneficiary-appeal-panel";
import { RepresentativePanel } from "./representative-panel";

export function BeneficiarySection(props: {
  readonly claimId: string;
  readonly refreshKey?: string | number;
  readonly onChanged?: () => void;
}): JSX.Element | null {
  const session = useSession();
  const has = (key: string): boolean => session?.permissions?.includes(key) ?? false;
  const canReadAppeals = has("beneficiary_appeal.read");
  const canReadAppointments = has("representative.read");
  if (!canReadAppeals && !canReadAppointments) return null;
  return (
    <>
      {canReadAppeals ? (
        <BeneficiaryAppealPanel
          key={`ben-${props.claimId}`}
          claimId={props.claimId}
          canManage={has("beneficiary_appeal.manage")}
          canReadAppointments={canReadAppointments}
          {...(props.refreshKey !== undefined ? { refreshKey: props.refreshKey } : {})}
          {...(props.onChanged ? { onChanged: props.onChanged } : {})}
        />
      ) : null}
      {canReadAppointments ? (
        <RepresentativePanel
          key={`rep-${props.claimId}`}
          claimId={props.claimId}
          canManage={has("representative.manage")}
          canVerify={has("representative.verify")}
          {...(props.refreshKey !== undefined ? { refreshKey: props.refreshKey } : {})}
          {...(props.onChanged ? { onChanged: props.onChanged } : {})}
        />
      ) : null}
    </>
  );
}
