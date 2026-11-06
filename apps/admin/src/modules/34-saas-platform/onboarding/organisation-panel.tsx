// apps/admin/src/modules/34-saas-platform/onboarding — step 1, Organisation: the display name and IANA time zone the tenant's
// organisation carries. The operator saves them (PATCH …/org-profile), then marks the step done with evidence that the customer
// confirmed them. The legal business name is fixed at provisioning and is not edited here.
import {
  Button,
  type Fact,
  FactList,
  TextField,
  stashStepUpDraft,
  useApiClient,
  useStepUpDraft,
} from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import { FailureNotice } from "./failure-notice";
import type { PanelContext } from "./panel-types";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { StepFrame } from "./step-frame";
import { useOpsWrite } from "./use-ops-write";

interface Draft {
  displayName: string;
  orgTimezone: string;
}

const draftKey = (orgSlug: string): string => `wizard:${orgSlug}:account_created:profile`;

/** The IANA zones the browser knows, as suggestions (the server is the judge of what it accepts). */
function timeZoneSuggestions(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  return typeof supported === "function" ? supported("timeZone") : [];
}

export function OrganisationPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const client = useApiClient();
  const { orgSlug, view, actions } = ctx;
  const key = draftKey(orgSlug);
  const restored = useStepUpDraft<Draft>(key);
  const [displayName, setDisplayName] = useState(
    restored?.displayName ?? view.orgProfile?.displayName ?? "",
  );
  const [orgTimezone, setOrgTimezone] = useState(
    restored?.orgTimezone ?? view.orgProfile?.orgTimezone ?? "",
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const write = useOpsWrite();
  const locked = actions.readOnlyReason !== null;

  async function save(): Promise<void> {
    if (displayName.trim().length === 0) {
      setNameError("Enter the display name.");
      return;
    }
    setNameError(null);
    const body = {
      displayName: displayName.trim(),
      ...(orgTimezone.trim() ? { orgTimezone: orgTimezone.trim() } : {}),
    };
    const outcome = await write.run(JSON.stringify(body), () =>
      client.PATCH("/api/v1/platform/tenants/{orgSlug}/org-profile", {
        params: { path: { orgSlug } },
        body,
      }),
    );
    if (outcome.ok) await ctx.refresh();
  }

  const facts: Fact[] = [
    {
      key: "name",
      label: "Display name is set",
      state: (view.orgProfile?.displayName ?? "").trim() ? "ok" : "pending",
    },
    {
      key: "zone",
      label: "Time zone is set",
      state: (view.orgProfile?.orgTimezone ?? "").trim() ? "ok" : "pending",
    },
  ];
  const failure = write.failure;

  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="Organisation profile">
        <div className="wx-drawer-card-head">
          <h3>Profile</h3>
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
        <PendingAttestationWarning view={view} />
        <TextField
          label="Display name"
          value={displayName}
          disabled={locked}
          onChange={(e) => setDisplayName(e.target.value)}
          error={nameError ?? failure?.fieldErrors.displayName}
        />
        <TextField
          label="Time zone"
          hint="An IANA name, for example America/Denver."
          list="wx-org-timezones"
          value={orgTimezone}
          disabled={locked}
          onChange={(e) => setOrgTimezone(e.target.value)}
          error={failure?.fieldErrors.orgTimezone}
        />
        <datalist id="wx-org-timezones">
          {timeZoneSuggestions().map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        {failure ? (
          <FailureNotice
            failure={failure}
            orgSlug={orgSlug}
            onReverify={() => stashStepUpDraft<Draft>(key, { displayName, orgTimezone })}
          />
        ) : null}
        {locked ? null : (
          <div className="wx-drawer-actions">
            <Button onClick={() => void save()} disabled={write.busy}>
              {write.busy ? "Saving…" : "Save profile"}
            </Button>
          </div>
        )}
      </section>
    </StepFrame>
  );
}
