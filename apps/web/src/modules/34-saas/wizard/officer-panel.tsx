// apps/web/src/modules/34-saas/wizard — step 12, Compliance officer. The officer attests go-live readiness, so the administrator picks
// one of the organization's own active staff who ALREADY holds the compliance officer role (PUT /api/v1/tenant/compliance-officer, a
// fresh step-up). ChartWarden alone assigns that role (separation of duties: an administrator cannot confer it, and the server refuses),
// so a person who lacks it is not offered; the panel says to ask ChartWarden. A colleague not on the list yet can be invited.
// Assigning a different officer voids a go-live attestation by the earlier one.
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
  TextField,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import type { ApiClient, operations } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../../shell/session";
import { FailureNotice } from "./failure-notice";
import { ORG_ADMIN_ROLE, type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { ONBOARDING_KEYS } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { useOpsWrite } from "./use-ops-write";
import { useWizardDraft } from "./wizard-drafts";
import { WIZARD_ERROR_COPY, viewHasMoved } from "./wizard-errors";
import { AskChartWardenSlot } from "./wizard-help-slot";
import { ROLE_COMPLIANCE_OFFICER } from "./wizard-model";

type Members =
  operations["getApiV1OrgsByIdMembers"]["responses"][200]["content"]["application/json"];
type Member = Members["members"][number];

/** The most staff whose roles are read to build the list; a larger organization is told the list is partial. */
const ROLE_LOOKUP_LIMIT = 100;
const DRAFT_NAME = "compliance-officer";
const labelOf = (m: Member): string => m.displayName ?? m.email ?? m.membershipId;

interface Eligible {
  readonly people: readonly Member[];
  readonly partial: boolean;
}

/** The organization's active staff who already hold the officer role. Fails with the first refused read. */
async function loadEligible(
  client: ApiClient,
  organizationId: string,
): Promise<{ data: Eligible } | { error: unknown; response: { status: number } }> {
  const roster = await client.GET("/api/v1/orgs/{id}/members", {
    params: { path: { id: organizationId } },
  });
  if (roster.error !== undefined || roster.data === undefined) {
    return { error: roster.error, response: roster.response };
  }
  const active = roster.data.members.filter((m) => m.status === "active");
  const read = active.slice(0, ROLE_LOOKUP_LIMIT);
  const held = await Promise.all(
    read.map((m) =>
      client.GET("/api/v1/memberships/{id}/roles", { params: { path: { id: m.membershipId } } }),
    ),
  );
  const refused = held.find((r) => r.error !== undefined);
  if (refused) return { error: refused.error, response: refused.response };
  const people = read
    .filter((_, i) => held[i]?.data?.roles.some((r) => r.roleKey === ROLE_COMPLIANCE_OFFICER))
    .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  return { data: { people, partial: active.length > ROLE_LOOKUP_LIMIT } };
}

function InviteForm({ organizationId }: { organizationId: string }): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function invite(): Promise<void> {
    setSent(false);
    const address = email.trim();
    if (!address.includes("@")) return setProblem("Enter their email address.");
    setProblem(null);
    const body = { email: address };
    const outcome = await write.run(JSON.stringify(body), (key) =>
      client.POST("/api/v1/orgs/{id}/invitations", {
        params: { path: { id: organizationId } },
        body,
        headers: { "Idempotency-Key": key },
      }),
    );
    if (outcome.ok) {
      setEmail("");
      setSent(true);
    }
  }

  return (
    <form
      className="wx-form-stack"
      aria-label="Invite someone"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void invite();
      }}
    >
      <TextField
        label="Invite a colleague"
        hint="They get an email invitation. Once they accept, ask ChartWarden to give them the compliance officer role."
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={problem ?? write.failure?.fieldErrors.email}
      />
      {write.failure ? <FailureNotice failure={write.failure} inputFields={["email"]} /> : null}
      <div className="wx-drawer-actions">
        <Button type="submit" tone="secondary" disabled={write.busy}>
          {write.busy ? "Sending…" : "Send invitation"}
        </Button>
      </div>
      <output className="wx-row-sub" aria-live="polite">
        {sent ? "Invitation sent." : ""}
      </output>
    </form>
  );
}

export function OfficerPanel({ step, view, held, roles, onChanged }: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const organizationId = useSession()?.organizationId ?? "";
  const open = isStepOpenForWork(view, step);
  const mayAssign =
    held.has(ONBOARDING_KEYS.manageOwn) && roles.has(ORG_ADMIN_ROLE) && organizationId !== "";
  const canWrite = open && mayAssign;
  // The staff list is read only to pick an officer: a panel that cannot assign does not read it.
  const staff = useLoad<Eligible>(
    `eligible:${canWrite}`,
    async () =>
      canWrite ? loadEligible(client, organizationId) : { data: { people: [], partial: false } },
    WIZARD_ERROR_COPY,
  );
  // Back from Re-verify the pick is as it was left.
  const { restored, stash } = useWizardDraft<{ picked: string }>(DRAFT_NAME);
  const [picked, setPicked] = useState<string | null>(restored?.picked ?? null);
  const write = useOpsWrite();

  const people = staff.data?.people ?? [];
  const currentId = view.goLive.complianceOfficerMembershipId;
  const current = people.find((m) => m.membershipId === currentId);

  async function assign(): Promise<void> {
    if (!picked) return;
    const body = { membershipId: picked };
    const outcome = await write.run(
      JSON.stringify(body),
      (key) =>
        client.PUT("/api/v1/tenant/compliance-officer", {
          body,
          headers: { "Idempotency-Key": key },
        }),
      async () => {
        await Promise.all([staff.reload(true), onChanged()]);
      },
    );
    if (outcome.ok) setPicked(null);
    else if (viewHasMoved(outcome.failure)) await onChanged();
  }

  const facts: Fact[] = [
    {
      key: "assigned",
      label: "A compliance officer is assigned",
      state: currentId ? "ok" : "pending",
    },
  ];

  return (
    <section className="wx-drawer-card" aria-label="Compliance officer">
      <div className="wx-drawer-card-head">
        <h3>Compliance officer</h3>
      </div>
      <FactList facts={facts} ariaLabel="What settles this step" />
      {currentId ? (
        <p>
          Current officer:{" "}
          <strong>{current ? labelOf(current) : "a member of your organization"}</strong>
        </p>
      ) : null}
      <PendingAttestationWarning view={view} />
      {staff.failure ? (
        <div className="wx-form-stack">
          <InlineAlert tone="error">Could not load your staff.</InlineAlert>
          <div>
            <Button tone="secondary" size="sm" onClick={() => void staff.reload()}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}
      {canWrite && staff.data && people.length === 0 ? (
        <p>
          ChartWarden assigns the compliance officer role. Ask ChartWarden to give it to the person
          you want, then choose them here.{" "}
          <AskChartWardenSlot topic="compliance_officer_assigned" />
        </p>
      ) : null}
      {staff.data?.partial ? (
        <p className="wx-row-sub">
          Showing staff from the first {ROLE_LOOKUP_LIMIT} active members only.
        </p>
      ) : null}
      {people.length > 0 ? (
        <fieldset className="wx-form-section">
          <legend className="wx-sr-only">Staff who hold the compliance officer role</legend>
          {people.map((m) => (
            <label key={m.membershipId} className="wx-action-check">
              <input
                type="radio"
                name="officer"
                checked={picked === m.membershipId}
                onChange={() => setPicked(m.membershipId)}
              />
              <span>
                {labelOf(m)}
                {m.email && m.displayName ? <span className="wx-row-sub"> {m.email}</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {write.failure ? (
        <FailureNotice failure={write.failure} onReverify={() => stash({ picked: picked ?? "" })} />
      ) : null}
      {canWrite && people.length > 0 ? (
        <div className="wx-drawer-actions">
          <Button disabled={picked === null || write.busy} onClick={() => void assign()}>
            {write.busy ? "Assigning…" : "Assign compliance officer"}
          </Button>
        </div>
      ) : null}
      {canWrite ? (
        <InviteForm organizationId={organizationId} />
      ) : open ? (
        <RoleCannot what="assign the compliance officer" />
      ) : null}
    </section>
  );
}
