// apps/admin/src/modules/34-saas-platform/onboarding — step 14, Go-live: two people. The tenant's compliance officer attests readiness in
// the tenant app; a DIFFERENT platform operator approves here (fresh step-up, a reason), and only then does the tenant go active and its
// organisation open. Approval re-judges the activation guards at that instant and lists every one that fails. A pending attestation is
// approvable for 14 days; an older one can only be revoked, so the officer attests again. The step itself is never attested or skipped.
import {
  Button,
  type Fact,
  FactList,
  InlineAlert,
  REASON_RULES,
  useApiClient,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { PanelContext } from "./panel-types";
import { RecordSaveDialog } from "./record-save-dialog";
import { StepFrame } from "./step-frame";
import { useOpsWrite } from "./use-ops-write";
import { GO_LIVE_STEP_KEY, type WizardStep } from "./wizard-model";

const DAY_MS = 24 * 60 * 60 * 1000;
const GUARD_COPY: Readonly<Record<string, string>> = {
  canonicalTasksComplete: "Every required step is done or skipped",
  baaExecuted: "The latest BAA is executed",
  baaExpiryClearsNinetyDays: "The executed BAA has more than 90 days left",
};

const isSettled = (s: WizardStep): boolean => s.status === "done" || s.status === "skipped";
const stepHref = (orgSlug: string, key: string): string =>
  `/tenants/${encodeURIComponent(orgSlug)}/onboarding/${encodeURIComponent(key)}`;

type Dialog = "approve" | "revoke" | null;

export function GoLivePanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view } = ctx;
  const { goLive } = view;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [done, setDone] = useState<string | null>(null);
  const write = useOpsWrite();

  const open = view.steps.filter(
    (s) => s.isCanonical && !s.optional && s.key !== GO_LIVE_STEP_KEY && !isSettled(s),
  );
  const attestation = goLive.attestation;
  const expiresAt = attestation?.expiresAt ? new Date(attestation.expiresAt).getTime() : null;
  const expired =
    goLive.state === "awaiting_approval" && expiresAt !== null && expiresAt <= Date.now();
  const daysLeft =
    expiresAt === null ? null : Math.max(Math.ceil((expiresAt - Date.now()) / DAY_MS), 0);
  const failing = goLive.failedGuards.filter((g) => g in GUARD_COPY);

  async function decide(kind: "approve" | "revoke", reason: string): Promise<void> {
    const body = { reason };
    const outcome = await write.run(`${kind}:${reason}`, () =>
      kind === "approve"
        ? client.POST("/api/v1/platform/tenants/{orgSlug}/go-live/approve", {
            params: { path: { orgSlug } },
            body,
          })
        : client.POST("/api/v1/platform/tenants/{orgSlug}/go-live/revoke", {
            params: { path: { orgSlug } },
            body,
          }),
    );
    if (outcome.ok) {
      setDialog(null);
      setDone(
        kind === "approve"
          ? "Approved. The tenant is live."
          : "Attestation revoked. The compliance officer can attest again.",
      );
      await ctx.refresh();
    }
  }

  const facts: Fact[] = [
    {
      key: "steps",
      label: "Every earlier required step is settled",
      state: open.length === 0 ? "ok" : "pending",
    },
    {
      key: "officer",
      label: "A compliance officer is assigned",
      state: goLive.complianceOfficerMembershipId ? "ok" : "pending",
    },
    {
      key: "attested",
      label: "The compliance officer has attested readiness",
      state: goLive.state === "awaiting_approval" || goLive.state === "live" ? "ok" : "pending",
    },
    ...failing.map((g) => ({
      key: g,
      label: GUARD_COPY[g] as string,
      state: "blocked" as const,
    })),
  ];

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="Go-live">
        <div className="wx-drawer-card-head">
          <h3>Go-live</h3>
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />

        {goLive.state === "not_ready" ? (
          <>
            <p>Go-live opens once every earlier step is settled.</p>
            {open.length > 0 ? (
              <ul>
                {open.map((s) => (
                  <li key={s.key}>
                    <Link to={stepHref(orgSlug, s.key)}>{s.title}</Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        {goLive.state === "awaiting_attestation" ? (
          <>
            <p>Waiting for the compliance officer to attest readiness in the tenant app.</p>
            {goLive.complianceOfficerMembershipId === null ? (
              <Link to={stepHref(orgSlug, "compliance_officer_assigned")}>
                Assign a compliance officer
              </Link>
            ) : null}
          </>
        ) : null}

        {goLive.state === "awaiting_approval" && attestation ? (
          <>
            <dl className="wx-kv">
              <dt>Attested</dt>
              <dd className="wx-nums">{new Date(attestation.attestedAt).toLocaleString()}</dd>
              {attestation.attestationNote ? (
                <>
                  <dt>Their note</dt>
                  <dd>{attestation.attestationNote}</dd>
                </>
              ) : null}
              <dt>Approvable for</dt>
              <dd>{expired ? "Expired" : `${daysLeft} days left to approve`}</dd>
            </dl>
            {expired ? (
              <InlineAlert tone="warning">
                This attestation is more than 14 days old. Revoke it so the compliance officer can
                attest again.
              </InlineAlert>
            ) : null}
            <InlineAlert tone="info">
              A different operator approves than the one who recorded the BAA. Approving re-checks
              every activation guard and opens the tenant's organization.
            </InlineAlert>
            <div className="wx-drawer-actions">
              <Button
                disabled={expired}
                onClick={() => {
                  write.clear();
                  setDialog("approve");
                }}
              >
                Approve go-live
              </Button>
              <Button
                tone="secondary"
                onClick={() => {
                  write.clear();
                  setDialog("revoke");
                }}
              >
                Revoke attestation
              </Button>
            </div>
          </>
        ) : null}

        {goLive.state === "live" ? (
          <>
            {attestation?.approvedAt ? (
              <dl className="wx-kv">
                <dt>Approved</dt>
                <dd className="wx-nums">{new Date(attestation.approvedAt).toLocaleString()}</dd>
                {attestation.approvalReason ? (
                  <>
                    <dt>Reason</dt>
                    <dd>{attestation.approvalReason}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}
          </>
        ) : null}

        {done ? <InlineAlert tone="success">{done}</InlineAlert> : null}
      </section>

      <RecordSaveDialog
        open={dialog === "approve"}
        title="Approve go-live"
        description="The tenant goes active and its organization opens. This is the second of the two people go-live takes."
        rule={REASON_RULES.decision}
        confirmLabel="Approve"
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void decide("approve", reason)}
        onCancel={() => setDialog(null)}
      />
      <RecordSaveDialog
        open={dialog === "revoke"}
        title="Revoke the go-live attestation"
        description="The compliance officer will have to attest again."
        rule={REASON_RULES.decision}
        tone="danger"
        confirmLabel="Revoke"
        write={write}
        orgSlug={orgSlug}
        onConfirm={(reason) => void decide("revoke", reason)}
        onCancel={() => setDialog(null)}
      />
    </StepFrame>
  );
}
