// apps/web/src/modules/15-discipline-care-plans — the Aide POC's care-team assignment form (spec §2.3).
//
// An Aide POC cannot be finalized, and no supervisory visit can be recorded, until the plan names the aide it directs and
// the RN who supervises that aide. The RN picks both BY NAME from the plan location's roster (`./aide-roster`), never typed
// ids; the server re-checks each against the same roster (`AIDE_NOT_ELIGIBLE` / `SUPERVISING_RN_NOT_ELIGIBLE`) and the save
// carries the plan row version as `If-Match`. A member the plan already binds but the roster no longer lists stays visible
// (so the screen never lies about who is assigned) and cannot be chosen again. Unavailable while the roster is, and on a
// discharged plan (read-only).
import { Button, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { AideRoster, AideRosterMember } from "./aide-roster";
import { type PlanDetail, assignAideTeam, errorMessage } from "./discipline-api";
import { shortId } from "./discipline-status";
import { Notice, SelectField } from "./discipline-ui";

const SAVE_FAILED = "The assignment could not be saved.";
const CONNECTION_FAILED = "The assignment was not saved. Check the connection and try again.";

/** The picker's choices: the roster by name, plus the plan's current member when the roster does not list them. */
function memberOptions(
  placeholder: string,
  members: readonly AideRosterMember[],
  boundId: string | null,
  rosterReady: boolean,
): { value: string; label: string; disabled?: boolean }[] {
  const listed = boundId !== null && members.some((m) => m.membershipId === boundId);
  return [
    { value: "", label: placeholder },
    ...members.map((m) => ({ value: m.membershipId, label: m.displayName })),
    ...(rosterReady && boundId !== null && !listed
      ? [{ value: boundId, label: `${shortId(boundId)} — not on the staff list`, disabled: true }]
      : []),
  ];
}

export function AideAssignmentForm({
  plan,
  roster,
  onSaved,
}: {
  plan: PlanDetail;
  roster: AideRoster;
  /** Called after a successful save; the screen reloads the plan (its row version moved). */
  onSaved: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [aideId, setAideId] = useState(plan.aideMembershipId ?? "");
  const [rnId, setRnId] = useState(plan.supervisingRnMembershipId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const discharged = plan.status === "discharged";
  const rosterReady = !roster.loading && roster.error === null;
  const unchanged =
    aideId === (plan.aideMembershipId ?? "") && rnId === (plan.supervisingRnMembershipId ?? "");
  const canSave = rosterReady && !discharged && aideId !== "" && rnId !== "" && !unchanged && !busy;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await assignAideTeam(client, plan.planId, plan.version, {
        aideMembershipId: aideId,
        supervisingRnMembershipId: rnId,
      });
      if (failure) {
        setError(errorMessage(failure, SAVE_FAILED));
        return;
      }
      await onSaved();
    } catch {
      setError(CONNECTION_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {discharged ? (
        <Notice tone="warning">This plan is discharged; its care team can no longer change.</Notice>
      ) : null}
      {roster.error ? (
        <div role="alert" className="wx-text-error">
          <p style={{ margin: 0 }}>
            {roster.error} The aide and supervising RN cannot be chosen until it loads.
          </p>
          <Button tone="secondary" type="button" onClick={roster.reload}>
            Retry
          </Button>
        </div>
      ) : null}
      <SelectField
        label="Aide"
        value={aideId}
        options={memberOptions("Select an aide", roster.aides, plan.aideMembershipId, rosterReady)}
        onChange={setAideId}
        disabled={!rosterReady || discharged || busy}
      />
      <SelectField
        label="Supervising RN"
        value={rnId}
        options={memberOptions(
          "Select a supervising RN",
          roster.supervisors,
          plan.supervisingRnMembershipId,
          rosterReady,
        )}
        onChange={setRnId}
        disabled={!rosterReady || discharged || busy}
      />
      {error ? (
        <p role="alert" className="wx-text-error">
          {error}
        </p>
      ) : null}
      <div>
        <Button tone="primary" type="button" onClick={() => void save()} disabled={!canSave}>
          {busy ? "Saving…" : "Assign care team"}
        </Button>
      </div>
    </>
  );
}
