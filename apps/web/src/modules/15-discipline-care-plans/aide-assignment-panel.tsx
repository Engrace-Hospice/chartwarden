// apps/web/src/modules/15-discipline-care-plans — the Aide POC's care-team assignment form (spec §2.3).
//
// An Aide POC cannot be finalized, and no supervisory visit can be recorded, until the plan names the aide it directs and
// the RN who supervises that aide. The RN picks both BY NAME from the plan location's roster (`./aide-roster`), never typed
// ids; the server re-checks each against the same roster (`AIDE_NOT_ELIGIBLE` / `SUPERVISING_RN_NOT_ELIGIBLE`) and the save
// carries the plan row version as `If-Match`. A member the plan already binds but the roster no longer lists stays visible
// (so the screen never lies about who is assigned) and cannot be chosen again. Unavailable while the roster is, and on a
// discharged plan (read-only).
//
// The picks live in the SCREEN (it owns the unsaved-changes guard and survives its own reloads), so this form is controlled:
// `aideId` / `rnId` are the effective choices (the plan's binding until the RN picks someone else).
import { Button, useApiClient } from "@chartwarden/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { AideRoster, AideRosterMember } from "./aide-roster";
import { type PlanDetail, assignAideTeam, errorMessage } from "./discipline-api";
import { shortId } from "./discipline-status";
import { Notice, SelectField } from "./discipline-ui";

const SAVE_FAILED = "The assignment could not be saved.";
const CONNECTION_FAILED =
  "The assignment may not have been saved. Reload the plan to check before trying again.";
const STALE = "This plan changed while you were working. Reload it, then choose again.";
const REFRESH_FAILED =
  "The assignment was saved, but the screen could not refresh. Reload the plan to see it.";

/** The effective choice: what the RN picked, or the plan's own binding while nothing was picked. */
export const effectivePick = (pick: string | null, bound: string | null): string =>
  pick ?? bound ?? "";

/** Whether the RN has chosen someone other than the plan's current binding (drives the unsaved-changes guard). */
export function aideTeamChanged(
  plan: Pick<PlanDetail, "aideMembershipId" | "supervisingRnMembershipId">,
  aidePick: string | null,
  rnPick: string | null,
): boolean {
  return (
    effectivePick(aidePick, plan.aideMembershipId) !== (plan.aideMembershipId ?? "") ||
    effectivePick(rnPick, plan.supervisingRnMembershipId) !== (plan.supervisingRnMembershipId ?? "")
  );
}

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
    ...(boundId !== null && !listed
      ? [
          {
            value: boundId,
            label: rosterReady ? `${shortId(boundId)} — not on the staff list` : shortId(boundId),
            disabled: true,
          },
        ]
      : []),
  ];
}

export function AideAssignmentForm({
  plan,
  roster,
  aideId,
  rnId,
  onAideChange,
  onRnChange,
  onSaved,
}: {
  plan: PlanDetail;
  roster: AideRoster;
  aideId: string;
  rnId: string;
  onAideChange: (id: string) => void;
  onRnChange: (id: string) => void;
  /** Called after a successful save, and by "Reload plan"; the screen reloads the plan (its row version moved). */
  onSaved: () => Promise<void>;
}): JSX.Element {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan moved under us (409) or the PUT's outcome is unknown: the picks are against an old version until reloaded.
  const [needsReload, setNeedsReload] = useState(false);

  const discharged = plan.status === "discharged";
  const rosterReady = !roster.loading && roster.error === null;
  const listed = (members: readonly AideRosterMember[], id: string) =>
    members.some((m) => m.membershipId === id);
  const canSave =
    rosterReady &&
    !discharged &&
    !needsReload &&
    !busy &&
    aideTeamChanged(plan, aideId, rnId) &&
    listed(roster.aides, aideId) &&
    listed(roster.supervisors, rnId);

  const pick = (apply: (id: string) => void) => (id: string) => {
    setError(null);
    apply(id);
  };

  async function reload(): Promise<void> {
    setBusy(true);
    try {
      await onSaved();
      setNeedsReload(false);
      setError(null);
    } catch {
      setError(REFRESH_FAILED);
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    let saved = false;
    try {
      const { error: failure, status } = await assignAideTeam(client, plan.planId, plan.version, {
        aideMembershipId: aideId,
        supervisingRnMembershipId: rnId,
      });
      if (failure) {
        const stale =
          status === 409 ||
          (failure as { error?: { code?: string } }).error?.code === "STALE_VERSION";
        setNeedsReload(stale);
        setError(stale ? STALE : errorMessage(failure, SAVE_FAILED));
        return;
      }
      saved = true;
    } catch {
      setNeedsReload(true);
      setError(CONNECTION_FAILED);
      return;
    } finally {
      setBusy(false);
    }
    if (saved) {
      try {
        await onSaved();
      } catch {
        setError(REFRESH_FAILED);
      }
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
        onChange={pick(onAideChange)}
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
        onChange={pick(onRnChange)}
        disabled={!rosterReady || discharged || busy}
      />
      {error ? (
        <p role="alert" className="wx-text-error">
          {error}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <Button tone="primary" type="button" onClick={() => void save()} disabled={!canSave}>
          {busy ? "Working…" : "Assign care team"}
        </Button>
        {needsReload ? (
          <Button tone="secondary" type="button" onClick={() => void reload()} disabled={busy}>
            Reload plan
          </Button>
        ) : null}
      </div>
    </>
  );
}
