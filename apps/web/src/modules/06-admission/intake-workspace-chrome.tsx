import {
  Card,
  CountBadge,
  Glyph,
  InlineAlert,
  PageHeader,
  Panel,
  StatusPill,
  formatDateOnly,
  t,
} from "@chartwarden/ui";
import type { JSX } from "react";
import {
  PATIENT_RESOLUTION_LABEL,
  PRIORITY_LABEL,
  REFERRAL_TONE,
  stateLabel,
} from "./admission-status";
import type { IntakeStepId, IntakeWorkspacePresentation } from "./intake-workspace-stage";
import type { ReferralView } from "./referrals-api";

export function IntakeIdentityHeader({
  referral,
  presentation,
}: {
  referral: ReferralView;
  presentation: IntakeWorkspacePresentation;
}): JSX.Element {
  const owner = referral.assignedToUserId
    ? referral.assignedToDisplayName || "Staff member"
    : "Unassigned";
  return (
    <>
      <PageHeader
        title="Referral workspace"
        actions={
          <div className="wx-intake-header-statuses">
            <StatusPill
              label={presentation.queueLabel}
              tone={REFERRAL_TONE[referral.status] ?? "neutral"}
            />
            <StatusPill
              label={PRIORITY_LABEL[referral.priority] ?? referral.priority}
              tone={
                referral.priority === "urgent"
                  ? "error"
                  : referral.priority === "high"
                    ? "warning"
                    : "neutral"
              }
            />
          </div>
        }
      >
        <p className="wx-intake-page-meta">
          {referral.externalReferralId ? `Referral ${referral.externalReferralId} · ` : ""}
          {sourceLabel(referral.source)} · Canonical status: {stateLabel(referral.status)}
        </p>
      </PageHeader>
      <div className="wx-intake-identity-shell">
        <Card padding={t.space4} aria-label="Referral context">
          <div className="wx-intake-identity-grid">
            <div className="wx-intake-person">
              <span className="wx-intake-avatar" aria-hidden="true">
                <Glyph name="user" size={24} />
              </span>
              <div>
                <h2>{referral.patientNameAtReceipt}</h2>
                <span>
                  {referral.patientDobAtReceipt
                    ? `DOB ${formatDateOnly(referral.patientDobAtReceipt)}`
                    : "Date of birth not provided"}
                  {referral.sexAssignedAtBirth ? ` · ${sexLabel(referral.sexAssignedAtBirth)}` : ""}
                </span>
              </div>
            </div>
            <IdentityFact
              label="Referral source"
              value={referral.referrerOrganization || sourceLabel(referral.source)}
            />
            <IdentityFact label="Received" value={formatReceived(referral.receivedAt)} />
            <IdentityFact label="Assigned to" value={owner} />
            <IdentityFact
              label="Patient association"
              value={
                PATIENT_RESOLUTION_LABEL[referral.patientResolutionStatus] ??
                referral.patientResolutionStatus
              }
            />
          </div>
        </Card>
      </div>
    </>
  );
}

export function IntakeAttentionPanel({
  presentation,
  displayedStepId,
  referralStatus,
}: {
  presentation: IntakeWorkspacePresentation;
  displayedStepId: IntakeStepId;
  referralStatus: ReferralView["status"];
}): JSX.Element {
  const count = presentation.blockers.length;
  return (
    <Panel
      title="Needs attention"
      icon={count > 0 ? "alert-circle" : "check-circle"}
      tone={count > 0 ? "danger" : "default"}
      action={count > 0 ? <CountBadge count={count} /> : undefined}
      description={
        count > 0
          ? "Resolve the server-reported items before the referral can advance."
          : "No referral qualification blockers are currently reported."
      }
      className="wx-intake-attention-panel"
      headingLevel={2}
    >
      {count > 0 ? (
        <ul className="wx-intake-blockers">
          {presentation.blockers.map((blocker) => (
            <li key={blocker}>
              <Glyph name="alert-circle" size={17} />
              <span>{blocker}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="wx-intake-clear-state">
          <Glyph name="check-circle" size={18} />
          <span>Current referral checks are clear.</span>
        </div>
      )}
      {referralStatus === "qualified" || displayedStepId === "handoff" ? (
        <InlineAlert tone="warning" live={false}>
          Referral qualification is not admission activation. Starting admission creates the
          admission workflow; election, certification, assessments, and activation remain separate.
        </InlineAlert>
      ) : null}
      <div className="wx-intake-next-action">
        <strong>Current task</strong>
        <span>{presentation.guidance}</span>
      </div>
    </Panel>
  );
}

function IdentityFact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <dl className="wx-intake-identity-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </dl>
  );
}

function formatReceived(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function sourceLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function sexLabel(value: ReferralView["sexAssignedAtBirth"]): string {
  if (value === "F") return "Female";
  if (value === "M") return "Male";
  if (value === "O") return "Other";
  return "Unknown";
}
