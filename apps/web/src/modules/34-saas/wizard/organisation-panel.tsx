// apps/web/src/modules/34-saas/wizard — step 1, Organisation: the display name and IANA time zone the organization carries. The
// administrator saves them (PATCH /api/v1/tenant/org-profile); ChartWarden then confirms the step. The legal business name is fixed at
// setup and is not edited here.
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
import { ORG_ADMIN_ROLE, type StepPanelProps, isStepOpenForWork } from "./panel-props";
import { PendingAttestationWarning } from "./pending-attestation-warning";
import { ONBOARDING_KEYS } from "./permissions";
import { RoleCannot } from "./role-cannot";
import { useOpsWrite } from "./use-ops-write";

interface Draft {
  displayName: string;
  orgTimezone: string;
}

const DRAFT_KEY = "wizard:account_created:profile";

/** The IANA zones the browser knows, as suggestions (the server is the judge of what it accepts). Read once: the list never changes. */
const TIME_ZONE_SUGGESTIONS: readonly string[] = (() => {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  return typeof supported === "function" ? supported("timeZone") : [];
})();

export function OrganisationPanel({
  step,
  view,
  held,
  roles,
  onChanged,
}: StepPanelProps): JSX.Element {
  const client = useApiClient();
  const restored = useStepUpDraft<Draft>(DRAFT_KEY);
  const [displayName, setDisplayName] = useState(
    restored?.displayName ?? view.orgProfile?.displayName ?? "",
  );
  const [orgTimezone, setOrgTimezone] = useState(
    restored?.orgTimezone ?? view.orgProfile?.orgTimezone ?? "",
  );
  const [nameError, setNameError] = useState<string | null>(null);
  // Saving a profile whose facts were already met changes nothing on screen, so the outcome is said (and announced) in words.
  const [saved, setSaved] = useState(false);
  const write = useOpsWrite();
  const mayEdit = held.has(ONBOARDING_KEYS.manageOwn) && roles.has(ORG_ADMIN_ROLE);
  const open = isStepOpenForWork(view, step);

  async function save(): Promise<void> {
    setSaved(false);
    if (displayName.trim().length === 0) {
      setNameError("Enter the display name.");
      return;
    }
    setNameError(null);
    const body = {
      displayName: displayName.trim(),
      ...(orgTimezone.trim() ? { orgTimezone: orgTimezone.trim() } : {}),
    };
    const outcome = await write.run(
      JSON.stringify(body),
      (key) =>
        client.PATCH("/api/v1/tenant/org-profile", { body, headers: { "Idempotency-Key": key } }),
      async () => onChanged(),
    );
    if (outcome.ok) setSaved(true);
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
  const locked = !open || !mayEdit;

  return (
    <section className="wx-drawer-card" aria-label="Organisation profile">
      <div className="wx-drawer-card-head">
        <h3>Profile</h3>
      </div>
      <FactList facts={facts} ariaLabel="What settles this step" />
      <PendingAttestationWarning view={view} />
      <form
        className="wx-form-stack"
        aria-label="Organisation profile form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!locked) void save();
        }}
      >
        <TextField
          label="Display name"
          value={displayName}
          disabled={locked}
          onChange={(e) => {
            setSaved(false);
            setDisplayName(e.target.value);
          }}
          error={nameError ?? failure?.fieldErrors.displayName}
        />
        <TextField
          label="Time zone"
          hint="An IANA name, for example America/Denver."
          list="wx-org-timezones"
          value={orgTimezone}
          disabled={locked}
          onChange={(e) => {
            setSaved(false);
            setOrgTimezone(e.target.value);
          }}
          error={failure?.fieldErrors.orgTimezone}
        />
        <datalist id="wx-org-timezones">
          {TIME_ZONE_SUGGESTIONS.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        {failure ? (
          <FailureNotice
            failure={failure}
            onReverify={() => stashStepUpDraft<Draft>(DRAFT_KEY, { displayName, orgTimezone })}
          />
        ) : null}
        {locked ? null : (
          <div className="wx-drawer-actions">
            <Button type="submit" disabled={write.busy}>
              {write.busy ? "Saving…" : "Save profile"}
            </Button>
          </div>
        )}
        {open && !mayEdit ? <RoleCannot what="change the organization's profile" /> : null}
        {/* always mounted, so a screen reader announces the text when it appears */}
        <output className="wx-row-sub" aria-live="polite">
          {saved ? "Profile saved." : ""}
        </output>
      </form>
    </section>
  );
}
