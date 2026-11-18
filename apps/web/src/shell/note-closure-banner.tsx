import { BACKGROUND_REQUEST_HEADERS, InlineAlert, useApiClient } from "@chartwarden/ui";
// apps/web/src/shell — the persistent visit-note closure banner (ADR-0113). Mounted once in the app frame, above the header, beside the
// system-status banner; it shows on every chromed screen while the clinician's oldest open note is at risk, overdue or blocking.
// Mode `off` and an `ok` stage render nothing. The two live regions (polite for info / warning, assertive for the blocking state)
// are ALWAYS mounted: a screen reader announces a change inside a region that was already there, not a region that just appeared.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useNoteClosure } from "./note-closure";
import { closureBannerModel } from "./note-closure-banner-model";
import type { ClosureBannerModel } from "./note-closure-banner-model";
import { NOTE_CLOSURE_HOME } from "./note-closure-screens";

const bannerStyle = { display: "block", padding: "0.5rem 1rem 0" } as const;
const linkStyle = { marginLeft: "0.5rem", textDecoration: "underline", color: "inherit" } as const;

/**
 * Where the "oldest note" link goes. closure-status names the note but not its patient, and the composer's route needs both, so the
 * patient is read once (GET /encounters/:id is on the gate's allowlist) and, until it arrives or if it cannot be read, the link
 * falls back to My notes, which lists the oldest note first. Only the blocked state resolves it.
 */
function useOldestNoteHref(encounterId: string | null): string {
  const client = useApiClient();
  const [resolved, setResolved] = useState<{ encounterId: string; patientId: string } | null>(null);
  useEffect(() => {
    if (encounterId === null) return;
    let active = true;
    client
      .GET("/api/v1/encounters/{encounterId}", {
        params: { path: { encounterId } },
        headers: BACKGROUND_REQUEST_HEADERS,
      })
      .then(({ data }) => {
        if (active && data) setResolved({ encounterId, patientId: data.patientId });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, encounterId]);
  return resolved !== null && resolved.encounterId === encounterId
    ? `/patients/${resolved.patientId}/encounters/${encounterId}/compose`
    : NOTE_CLOSURE_HOME;
}

function BannerContent({ model }: { model: ClosureBannerModel }): JSX.Element {
  const oldestNoteHref = useOldestNoteHref(model.blocked ? model.encounterId : null);
  return (
    <InlineAlert tone={model.tone} live={false}>
      <strong>{model.title}.</strong> {model.detail}
      <Link to={model.blocked ? oldestNoteHref : NOTE_CLOSURE_HOME} style={linkStyle}>
        {model.blocked ? "Open the oldest note" : "Open My notes"}
      </Link>
    </InlineAlert>
  );
}

export function NoteClosureBanner(): JSX.Element {
  const { status } = useNoteClosure();
  const model = closureBannerModel(status, new Date());
  return (
    <>
      <output style={model && !model.blocked ? bannerStyle : undefined}>
        {model && !model.blocked ? <BannerContent model={model} /> : null}
      </output>
      <div role="alert" style={model?.blocked ? bannerStyle : undefined}>
        {model?.blocked ? <BannerContent model={model} /> : null}
      </div>
    </>
  );
}
