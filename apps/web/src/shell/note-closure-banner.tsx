import { InlineAlert } from "@chartwarden/ui";
// apps/web/src/shell — the persistent visit-note closure banner (ADR-0113). Mounted once in the app frame, above the header, beside the
// system-status banner; it shows on every chromed screen while the clinician's oldest open note is at risk, overdue or blocking.
// Mode `off` and an `ok` stage render nothing. The polite region (info / warning) is ALWAYS mounted, because a screen reader announces
// a change inside a region that was already there. The blocking state is a `role="alert"` mounted only while blocked (an alert is
// announced on insertion), the offline banner's convention: an empty alert on every screen would also break the screens that
// assert they show none.
//
// The blocked link goes straight to the oldest note (`model.oldestNoteHref`: the composer for a draft, the read screen where a finalized
// note is signed). closure-status already carries that note's patient and status, so the banner never reads the encounter itself: a
// GET /encounters/:id is read-audited, and every blocked episode would have logged an `encounter.viewed` disclosure nobody viewed.
// Without a note to link (null) the link falls back to My notes.
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { useNoteClosure } from "./note-closure";
import { closureBannerModel } from "./note-closure-banner-model";
import type { ClosureBannerModel } from "./note-closure-banner-model";
import { NOTE_CLOSURE_HOME } from "./note-closure-screens";

const bannerStyle = { display: "block", padding: "0.5rem 1rem 0" } as const;
const linkStyle = { marginLeft: "0.5rem", textDecoration: "underline", color: "inherit" } as const;

function BannerContent({ model }: { model: ClosureBannerModel }): JSX.Element {
  return (
    <InlineAlert tone={model.tone} live={false}>
      <strong>{model.title}.</strong> {model.detail}
      <Link to={model.oldestNoteHref ?? NOTE_CLOSURE_HOME} style={linkStyle}>
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
      {model?.blocked ? (
        <div role="alert" style={bannerStyle}>
          <BannerContent model={model} />
        </div>
      ) : null}
    </>
  );
}
