// apps/web/src/modules/08-encounters — display names for the clinicians on the supervisor board. The board's rows carry only a membership
// id and no route resolves one id at a time, so this is ONE best-effort read of the care-team staff list (patient.assign or idg.read;
// the same list the assign dialog uses). A supervisor who may not read it, a list longer than the route's cap, or an outage all end the
// same way: the id is not in the map and the screen shows a short id instead. Nothing here is an error the person needs to see.
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import { useSession } from "../../shell/session";
import { loadStaffNames } from "./closure-api";

/** Membership id to display name; absent = not resolved (still loading, unreadable, or past the lookup's cap). */
export type StaffNames = Readonly<Record<string, string>>;

const SHORT_ID_LENGTH = 8;

export function useStaffNames(): StaffNames {
  const client = useApiClient();
  const organizationId = useSession()?.organizationId ?? "";
  const [names, setNames] = useState<StaffNames>({});

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    void loadStaffNames(client, organizationId).then((outcome) => {
      if (!active || !outcome.ok) return;
      setNames(
        Object.fromEntries(
          outcome.data.flatMap((s) => (s.displayName ? [[s.membershipId, s.displayName]] : [])),
        ),
      );
    });
    return () => {
      active = false;
    };
  }, [client, organizationId]);

  return names;
}

/** The clinician's name, else a neutral label with the id's first characters (enough to tell two apart, never a guess at a name). */
export function clinicianLabel(names: StaffNames, membershipId: string): string {
  return names[membershipId] ?? `Clinician ${membershipId.slice(0, SHORT_ID_LENGTH)}`;
}
