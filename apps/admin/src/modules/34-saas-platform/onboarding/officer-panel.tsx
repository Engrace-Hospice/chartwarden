// apps/admin/src/modules/34-saas-platform/onboarding — step 12, People: compliance officer. The officer attests go-live readiness in the
// tenant app, so the operator picks one of the tenant's own active staff by name and says why; the server binds the role where the
// member lacks it, and refuses ChartWarden staff (and the operator) as officers. Assigning a different officer voids a go-live
// attestation by the earlier one. The picker reads the tenant's active staff (name, email, roles: nothing else).
import { Button, type Fact, FactList, REASON_RULES, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { PanelContext } from "./panel-types";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { RecordSaveDialog } from "./record-save-dialog";
import { StepFrame } from "./step-frame";
import { useLoad } from "./use-load";
import { useOpsWrite } from "./use-ops-write";

interface Member {
  membershipId: string;
  displayName: string | null;
  email: string | null;
  roleKeys: string[];
}

const OFFICER_ROLE = "compliance_officer";
const labelOf = (m: Member): string => m.displayName ?? m.email ?? m.membershipId;

export function OfficerPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view, actions } = ctx;
  const canWrite = actions.readOnlyReason === null;
  const members = useLoad<{ items: Member[] }>(`members:${orgSlug}`, () =>
    client.GET("/api/v1/platform/tenants/{orgSlug}/members", { params: { path: { orgSlug } } }),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const write = useOpsWrite();

  // Those who already hold the role first, then by name.
  const people = [...(members.data?.items ?? [])].sort((a, b) => {
    const aOfficer = a.roleKeys.includes(OFFICER_ROLE);
    const bOfficer = b.roleKeys.includes(OFFICER_ROLE);
    return aOfficer === bOfficer ? labelOf(a).localeCompare(labelOf(b)) : aOfficer ? -1 : 1;
  });
  const currentId = view.goLive.complianceOfficerMembershipId;
  const current = people.find((m) => m.membershipId === currentId);

  async function assign(reason: string): Promise<void> {
    if (!picked) return;
    const body = { membershipId: picked, reason };
    const outcome = await write.run(JSON.stringify(body), () =>
      client.PUT("/api/v1/platform/tenants/{orgSlug}/compliance-officer", {
        params: { path: { orgSlug } },
        body,
      }),
    );
    if (outcome.ok) {
      setAsking(false);
      setPicked(null);
      await ctx.refresh();
    }
  }

  const facts: Fact[] = [
    {
      key: "assigned",
      label: "A compliance officer is assigned",
      state: currentId ? "ok" : "pending",
    },
  ];

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="Compliance officer">
        <div className="wx-drawer-card-head">
          <h3>Compliance officer</h3>
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
        {currentId ? (
          <p>
            Current officer:{" "}
            <strong>{current ? labelOf(current) : "a member of this tenant"}</strong>
          </p>
        ) : null}
        <PendingAttestationWarning view={view} />
        {members.failure ? <p role="alert">Could not load the tenant's staff.</p> : null}
        {members.data && people.length === 0 ? (
          <p>
            This tenant has no active staff yet. Once the first admin has accepted their invitation
            and added staff, pick the compliance officer here.
          </p>
        ) : null}
        {people.length > 0 ? (
          <fieldset className="wx-form-section" aria-label="Tenant staff">
            <legend className="wx-sr-only">Tenant staff</legend>
            {people.map((m) => {
              const isOfficer = m.roleKeys.includes(OFFICER_ROLE);
              return (
                <label key={m.membershipId} className="wx-action-check">
                  <input
                    type="radio"
                    name="officer"
                    aria-label={`${labelOf(m)}${m.email && m.displayName ? ` (${m.email})` : ""}`}
                    checked={picked === m.membershipId}
                    disabled={!canWrite}
                    onChange={() => setPicked(m.membershipId)}
                  />
                  <span>
                    {labelOf(m)}
                    {m.email && m.displayName ? (
                      <span className="wx-row-sub"> {m.email}</span>
                    ) : null}
                    {isOfficer ? (
                      <span className="wx-row-sub"> · Compliance officer role</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        ) : null}
        {canWrite && people.length > 0 ? (
          <div className="wx-drawer-actions">
            <Button
              disabled={picked === null}
              onClick={() => {
                write.clear();
                setAsking(true);
              }}
            >
              Assign compliance officer
            </Button>
          </div>
        ) : null}
      </section>

      <RecordSaveDialog
        open={asking}
        title="Assign the compliance officer"
        description="The role is given to this member if they do not hold it yet. Their go-live attestation will be needed before the tenant can go live."
        rule={REASON_RULES.officer}
        confirmLabel="Assign"
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void assign(reason)}
        onCancel={() => setAsking(false)}
      />
    </StepFrame>
  );
}
