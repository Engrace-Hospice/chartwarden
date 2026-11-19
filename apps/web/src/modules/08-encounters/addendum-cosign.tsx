// apps/web/src/modules/08-encounters — the cosigner's panel on a signed amendment whose cosignature is pending (ADR-0114 VN-D30, S1 PR E4).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md "Cosigning an Amendment".
//
// An amending addendum of a note that needed a cosigner opens its own cosignature request. This is where that request is worked: the same
// acknowledge / sign / supervisor-release ceremony the note has (`use-cosign-ceremony.ts`), against the amendment's own routes. It is offered
// only to a viewer who may act (`cosignAbility`: the session's permissions, and not the author of the note or the amendment); anyone else is
// told, in words, why there is nothing for them to do. The server still judges every step and its refusals are worded in the dialog. The
// panel carries the anchor the cosignature queue links to: opened from there it is scrolled to and focused. It shows the names of the amended
// sections and the author's reason, never any section text, so a Part 2 section is never rendered here.
import { Button, t, useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useLocation } from "react-router-dom";
import { useSession } from "../../shell/session";
import { type AddendumRow, loadAddendumCosignature } from "./addenda-api";
import { CosignCeremonyModals } from "./cosign-ceremony-modals";
import {
  amendmentCosignAnchor,
  cosignAbility,
  cosignActionsFor,
  cosignRequestWords,
} from "./cosign-model";
import { humanizeSection } from "./sign-draft-notice";
import { shortStamp } from "./signed-note-model";
import { useCosignCeremony } from "./use-cosign-ceremony";
import { useIsMounted } from "./use-is-mounted";

interface Props {
  readonly encounterId: string;
  readonly addendum: AddendumRow;
  /** The signed note's author (membership id), when the page knows it: the note's author cannot cosign its amendment either. */
  readonly noteAuthorId: string | null;
  /** Read the encounter again after a step lands, so the amendment's status comes from the server again. */
  readonly onChanged: () => void;
}

type RequestRead =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly status: string | null }
  | { readonly state: "failed" };

export function AddendumCosign({
  encounterId,
  addendum,
  noteAuthorId,
  onChanged,
}: Props): JSX.Element | null {
  const client = useApiClient();
  const session = useSession();
  const { hash } = useLocation();
  const mounted = useIsMounted();
  const panel = useRef<HTMLElement>(null);
  const anchorId = amendmentCosignAnchor(addendum.id);
  const ability = cosignAbility(session, {
    addendumAuthorId: addendum.authoredByUserId,
    noteAuthorId,
  });
  const mayWork = ability.acknowledgeAndSign || ability.release;
  const [request, setRequest] = useState<RequestRead>({ state: "loading" });

  const readRequest = useCallback(async () => {
    const res = await loadAddendumCosignature(client, { encounterId, addendumId: addendum.id });
    if (!mounted.current) return;
    setRequest(res.ok ? { state: "ready", status: res.value.status } : { state: "failed" });
  }, [client, encounterId, addendum.id, mounted]);

  // Only someone who may act needs the request's own state; everyone else reads the amendment's status from the encounter.
  useEffect(() => {
    if (mayWork) void readRequest();
  }, [mayWork, readRequest]);

  const subject = useMemo(
    () => ({ kind: "addendum" as const, encounterId, addendumId: addendum.id }),
    [encounterId, addendum.id],
  );
  const ceremony = useCosignCeremony(subject, () => {
    void readRequest();
    onChanged();
  });

  // Opened from the cosignature queue: the link's anchor names this panel.
  useEffect(() => {
    if (hash !== `#${anchorId}`) return;
    panel.current?.scrollIntoView?.({ block: "center" });
    panel.current?.focus();
  }, [hash, anchorId]);

  if (!mayWork && ability.refusal === null) return null;

  const status = request.state === "ready" ? request.status : null;
  const steps = cosignActionsFor(status);
  const canAcknowledge = ability.acknowledgeAndSign && steps.acknowledge;
  const canSign = ability.acknowledgeAndSign && steps.sign;
  const canRelease = ability.release && steps.release;
  const amended = (addendum.amendsSectionIds ?? []).map(humanizeSection).join(", ");

  return (
    // Named by when the addendum was opened (a note can carry several amendments, and a landmark name must tell them apart).
    <section
      id={anchorId}
      ref={panel}
      tabIndex={-1}
      aria-label={`Cosign this amendment, opened ${shortStamp(addendum.createdAt)}`}
      style={box}
    >
      {ability.refusal !== null ? <p style={metaText}>{ability.refusal}</p> : null}
      {mayWork && request.state === "loading" ? (
        <p style={metaText}>Reading the cosignature request…</p>
      ) : null}
      {mayWork && request.state === "failed" ? (
        <p role="alert" style={alertText}>
          The cosignature request could not be read right now. Reload the page to try again.
        </p>
      ) : null}
      {mayWork && request.state === "ready" ? (
        <>
          {cosignRequestWords(status) !== null ? (
            <p style={reasonText}>{cosignRequestWords(status)}</p>
          ) : null}
          {canAcknowledge || canSign ? (
            <p style={metaText}>
              Review the amended sections in the signed note (Version history) before you cosign.
            </p>
          ) : null}
          <div style={actions}>
            {canAcknowledge ? (
              <Button size="sm" tone="secondary" onClick={() => ceremony.open("acknowledge")}>
                Acknowledge cosignature
              </Button>
            ) : null}
            {canSign ? (
              <Button size="sm" onClick={() => ceremony.open("sign")}>
                Sign cosignature
              </Button>
            ) : null}
            {canRelease ? (
              <Button size="sm" tone="secondary" onClick={() => ceremony.open("release")}>
                Supervisor release
              </Button>
            ) : null}
          </div>
          <CosignCeremonyModals
            ceremony={ceremony}
            subject="addendum"
            heading="Cosign amendment"
            facts={[
              { label: "Reason for the amendment", value: addendum.reason },
              { label: "Sections amended", value: amended },
            ]}
          />
        </>
      ) : null}
    </section>
  );
}

const box: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  paddingLeft: "0.7rem",
  borderLeft: `3px solid ${t.outlineVariant}`,
};
const metaText: CSSProperties = { margin: 0, fontSize: "0.72rem", color: t.onSurfaceVariant };
const reasonText: CSSProperties = { margin: 0, fontSize: "0.82rem", color: t.onSurface };
const alertText: CSSProperties = { margin: 0, fontSize: "0.78rem", color: t.error };
const actions: CSSProperties = { display: "flex", gap: "0.5rem", flexWrap: "wrap" };
