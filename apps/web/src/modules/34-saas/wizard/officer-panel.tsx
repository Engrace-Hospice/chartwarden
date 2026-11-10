// apps/web/src/modules/34-saas/wizard — step 12, Compliance officer. The officer attests go-live readiness, so the administrator picks one
// of the organization's own active staff (PUT /api/v1/tenant/compliance-officer, a fresh step-up). The officer must hold the
// compliance officer role: the panel gives it to the person first when they lack it. Someone not on the list yet can be invited here.
// Assigning a different officer voids a go-live attestation by the earlier one.
import {
  type ApiClient,
  Button,
  type Fact,
  FactList,
  InlineAlert,
  TextField,
  stashStepUpMemoryDraft,
  useApiClient,
  useLoad,
  useStepUpMemoryDraft,
} from "@chartwarden/ui";
import type { operations } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { useSession } from "../../../shell/session";
import { FailureNotice } from "./failure-notice";
import { ORG_ADMIN_ROLE, type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { ONBOARDING_KEYS } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { useOpsWrite } from "./use-ops-write";
import { WIZARD_ERROR_COPY } from "./wizard-errors";
import { ROLE_COMPLIANCE_OFFICER } from "./wizard-model";

type Members =
  operations["getApiV1OrgsByIdMembers"]["responses"][200]["content"]["application/json"];
type Member = Members["members"][number];

const DRAFT_KEY = "wizard:compliance_officer_assigned:assign";
const labelOf = (m: Member): string => m.displayName ?? m.email ?? m.membershipId;

/** A refusal in the shape `useOpsWrite` reads, so the role grant's refusal is told like any other. */
interface Refusal {
  readonly error: unknown;
  readonly response: { readonly status: number };
}

/** Gives the member the compliance officer role when they lack it. Null when they hold it (or now do); else the refusal. */
async function ensureOfficerRole(client: ApiClient, membershipId: string): Promise<Refusal | null> {
  const path = { params: { path: { id: membershipId } } };
  const held = await client.GET("/api/v1/memberships/{id}/roles", path);
  if (held.error !== undefined) return { error: held.error, response: held.response };
  if (held.data?.roles.some((r) => r.roleKey === ROLE_COMPLIANCE_OFFICER)) return null;
  const catalog = await client.GET("/api/v1/roles");
  if (catalog.error !== undefined) return { error: catalog.error, response: catalog.response };
  const role = catalog.data?.roles.find((r) => r.key === ROLE_COMPLIANCE_OFFICER);
  if (!role) {
    return {
      error: { error: { code: "COMPLIANCE_OFFICER_LACKS_ROLE", message: "no such role" } },
      response: { status: 422 },
    };
  }
  const granted = await client.POST("/api/v1/memberships/{id}/roles", {
    ...path,
    body: { roleId: role.roleId },
  });
  return granted.error === undefined ? null : { error: granted.error, response: granted.response };
}

function InviteForm({
  organizationId,
  onSent,
}: { organizationId: string; onSent: () => void }): JSX.Element {
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
    const body = { email: address, proposedRoleKeys: [ROLE_COMPLIANCE_OFFICER] };
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
      onSent();
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
        label="Invite someone as compliance officer"
        hint="They get an email invitation. Once they accept, pick them above."
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={problem ?? write.failure?.fieldErrors.email}
      />
      {write.failure ? <FailureNotice failure={write.failure} /> : null}
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
  const members = useLoad<Members>(
    `members:${canWrite}`,
    async () =>
      canWrite
        ? client.GET("/api/v1/orgs/{id}/members", { params: { path: { id: organizationId } } })
        : { data: { members: [], pendingInvitations: 0 } },
    WIZARD_ERROR_COPY,
  );
  // Back from Re-verify the pick is as it was left.
  const restored = useStepUpMemoryDraft<{ picked: string }>(DRAFT_KEY);
  const [picked, setPicked] = useState<string | null>(restored?.picked ?? null);
  const write = useOpsWrite();

  const people = (members.data?.members ?? [])
    .filter((m) => m.status === "active")
    .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  const currentId = view.goLive.complianceOfficerMembershipId;
  const current = people.find((m) => m.membershipId === currentId);

  async function assign(): Promise<void> {
    if (!picked) return;
    const membershipId = picked;
    const body = { membershipId };
    const outcome = await write.run(
      JSON.stringify(body),
      async (key) =>
        (await ensureOfficerRole(client, membershipId)) ??
        client.PUT("/api/v1/tenant/compliance-officer", {
          body,
          headers: { "Idempotency-Key": key },
        }),
      async () => {
        await Promise.all([members.reload(true), onChanged()]);
      },
    );
    if (outcome.ok) setPicked(null);
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
      {members.failure ? (
        <div className="wx-form-stack">
          <InlineAlert tone="error">Could not load your staff.</InlineAlert>
          <div>
            <Button tone="secondary" size="sm" onClick={() => void members.reload()}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}
      {canWrite && members.data && people.length === 0 ? (
        <p>
          No one else is active yet. Invite your compliance officer below, then pick them here once
          they accept.
        </p>
      ) : null}
      {people.length > 0 ? (
        <fieldset className="wx-form-section">
          <legend className="wx-sr-only">Your staff</legend>
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
        <FailureNotice
          failure={write.failure}
          onReverify={() => stashStepUpMemoryDraft(DRAFT_KEY, { picked: picked ?? "" })}
        />
      ) : null}
      {canWrite && people.length > 0 ? (
        <div className="wx-drawer-actions">
          <Button disabled={picked === null || write.busy} onClick={() => void assign()}>
            {write.busy ? "Assigning…" : "Assign compliance officer"}
          </Button>
        </div>
      ) : null}
      {canWrite ? (
        <InviteForm organizationId={organizationId} onSent={() => void members.reload(true)} />
      ) : open ? (
        <RoleCannot what="assign the compliance officer" />
      ) : null}
    </section>
  );
}
