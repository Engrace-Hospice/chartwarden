import { type ApiClient, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import { useNoteClosure } from "../../../shell/note-closure";
// apps/web/src/modules/08-encounters/workspace — what the visit context header adds for an encounter that belongs to a scheduled visit: the
// visit's scheduled window and the assigned clinician (Workflow 09, WP1). Best effort and never blocking: the header renders from the
// encounter alone, these arrive when they arrive, and a read that fails or answers something unexpected (a caller without `visit.read`, a
// visit outside the caseload, an outage) shows nothing at all rather than an error. Both reads are existing audited routes the visit
// screens already use; nothing here decides access (the server does).
import { canAuthorEncounters } from "../../../shell/note-href";
import { useSession } from "../../../shell/session";
import { staffDirectory } from "./staff-directory";

export interface VisitContext {
  readonly scheduledStartedAt: string;
  readonly scheduledEndedAt: string;
  /** The assigned clinician's display name, when the staff list could be read and names them. */
  readonly clinicianName: string | null;
}

interface VisitRead {
  scheduledStartedAt?: unknown;
  scheduledEndedAt?: unknown;
  assignedMembershipId?: unknown;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The scheduled visit's window and clinician, or null while unknown or when it cannot be read. `readStaff` false leaves the clinician's
 * name out without asking for it (the staff list is a route the note-closure gate refuses a blocked clinician).
 */
async function loadVisitContext(
  client: ApiClient,
  visitId: string,
  staffScope: string,
  readStaff: boolean,
): Promise<VisitContext | null> {
  try {
    const res = await client.GET("/api/v1/visits/{visitId}", { params: { path: { visitId } } });
    const visit = res?.data as VisitRead | null | undefined;
    if (!visit || !isText(visit.scheduledStartedAt) || !isText(visit.scheduledEndedAt)) return null;
    const clinicianName =
      readStaff && isText(visit.assignedMembershipId)
        ? ((await staffDirectory(client, staffScope)).get(visit.assignedMembershipId) ?? null)
        : null;
    return {
      scheduledStartedAt: visit.scheduledStartedAt,
      scheduledEndedAt: visit.scheduledEndedAt,
      clinicianName,
    };
  } catch {
    return null;
  }
}

/** `visitId` null (a PRN encounter) reads nothing. A new visit id starts from nothing, not from the previous visit's window. */
export function useVisitContext(visitId: string | null): VisitContext | null {
  const client = useApiClient();
  const session = useSession();
  // The staff list is held per signed-in user (see staff-directory.ts).
  const staffScope = `${session?.organizationId ?? ""}:${session?.userId ?? ""}`;
  // A clinician the note-closure gate blocks is refused the staff list (it is not on the gate's allowlist, the visit read is): ask for
  // neither the list nor a closure re-read it would trigger, and show the visit without the clinician's name, as when the read fails.
  // Only an author can be blocked, and an author's first closure answer may not have arrived when the screen opens: wait for it (the
  // names are simply absent if it never comes) rather than ask first and be refused. A non-author never has an answer to wait for.
  const closure = useNoteClosure().status;
  const mayBeBlocked = canAuthorEncounters(session?.permissions);
  const readStaff = closure === null ? !mayBeBlocked : closure.verdict !== "blocked";
  const [held, setHeld] = useState<{ visitId: string; context: VisitContext } | null>(null);

  useEffect(() => {
    if (!visitId) return;
    let current = true;
    void loadVisitContext(client, visitId, staffScope, readStaff).then((context) => {
      if (current && context) setHeld({ visitId, context });
    });
    return () => {
      current = false;
    };
  }, [client, visitId, staffScope, readStaff]);

  return held !== null && held.visitId === visitId ? held.context : null;
}
