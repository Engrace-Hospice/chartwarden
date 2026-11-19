// apps/web/src/modules/08-encounters — the signed note on the encounter record, section by section (ADR-0114 VN-D30, S1 PR E3).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md "The Signed Note's Part 2 View".
//
// The text comes from `finalDocumentationView`, never from the legacy `finalDocumentation` string (which still carries a generic withheld
// sentence for a viewer without Part 2 disclosure): `fallbackText` is shown ONLY when the API sent no structured view. Withheld text is a
// labelled block that cannot be mistaken for the clinician's words: it has no text to select or copy, no action, and is never empty.
// An amended section says so with the date of its latest version and opens every version (`noteHistory`); a native `<details>` keeps the
// disclosure keyboard- and screen-reader-complete with no script.
import { Glyph, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { amendmentCosignTone, amendmentCosignWords } from "./cosign-model";
import { humanizeSection } from "./sign-draft-notice";
import {
  type FinalDocumentationView,
  type NoteHistory,
  type NoteSection,
  type NoteVersion,
  WITHHELD_LABEL,
  WITHHELD_NOTE_TEXT,
  WITHHELD_SECTION_TEXT,
  WITHHELD_VERSION_TEXT,
  historyOfSection,
  shortStamp,
  versionCount,
} from "./signed-note-model";

type WithheldScope = "section" | "note" | "version";

const WITHHELD_TEXT: Readonly<Record<WithheldScope, string>> = {
  section: WITHHELD_SECTION_TEXT,
  note: WITHHELD_NOTE_TEXT,
  version: WITHHELD_VERSION_TEXT,
};

/** Text this reader may not see: said in words, in a block that is visibly not note text. Never empty, never actionable. */
export function WithheldNotice({ scope }: { readonly scope: WithheldScope }): JSX.Element {
  return (
    <div className="wx-note-withheld" role="note">
      <Glyph name="lock" size={16} />
      <strong>{WITHHELD_LABEL}</strong>
      <span>{WITHHELD_TEXT[scope]}</span>
    </div>
  );
}

function SectionText({
  section,
  scope,
}: {
  readonly section: Pick<NoteSection, "text" | "withheld">;
  readonly scope: WithheldScope;
}): JSX.Element {
  if (section.withheld) return <WithheldNotice scope={scope} />;
  if (section.text === null) {
    return <p className="wx-row-sub">No text is recorded for this section.</p>;
  }
  return <p className="wx-note-text">{section.text}</p>;
}

function VersionRow({ version }: { readonly version: NoteVersion }): JSX.Element {
  // An amendment's own cosignature, in words: nothing for the original, or when none was required or the API stated none.
  const cosignWords = amendmentCosignWords(version.cosignStatus);
  return (
    <li className="wx-note-version">
      <div className="wx-note-version-head">
        <strong>{version.kind === "original" ? "Original" : "Amendment"}</strong>
        {version.current ? <StatusPill label="Current" tone="success" /> : null}
        {cosignWords !== null && version.cosignStatus ? (
          <StatusPill label={cosignWords} tone={amendmentCosignTone(version.cosignStatus)} />
        ) : null}
        {version.signedAt ? (
          <time dateTime={version.signedAt} className="wx-row-sub">
            {shortStamp(version.signedAt)}
          </time>
        ) : null}
        <span className="wx-row-sub wx-note-mono">{version.authoredByMembershipId}</span>
      </div>
      <SectionText section={version} scope="version" />
    </li>
  );
}

function VersionHistory({
  versions,
}: { readonly versions: readonly NoteVersion[] | null }): JSX.Element {
  if (versions === null) {
    return <p className="wx-row-sub">Earlier versions are not available.</p>;
  }
  return (
    <details className="wx-note-history">
      <summary>Version history ({versionCount(versions)} versions)</summary>
      <ol className="wx-note-versions">
        {versions.map((version) => (
          <VersionRow
            key={`${version.kind}-${version.addendumId ?? "original"}`}
            version={version}
          />
        ))}
      </ol>
    </details>
  );
}

function NoteSectionBlock({
  section,
  history,
}: {
  readonly section: NoteSection;
  readonly history: NoteHistory | null | undefined;
}): JSX.Element {
  const amended = section.amendedByAddendumId !== null;
  const body = (
    <>
      <SectionText section={section} scope="section" />
      {amended ? (
        <VersionHistory versions={historyOfSection(history, section.sectionId ?? "")} />
      ) : null}
    </>
  );
  // A pin with no sealed rows is the one block of narrative: no heading, as the page always showed it.
  if (section.sectionId === null) return <div className="wx-note-section">{body}</div>;
  const headingId = `note-section-${section.sectionId}`;
  return (
    <section className="wx-note-section" aria-labelledby={headingId}>
      <header className="wx-note-section-head">
        <h3 id={headingId} className="wx-note-section-title">
          {humanizeSection(section.sectionId)}
        </h3>
        {amended ? <StatusPill label="Amended" tone="progress" /> : null}
        {amended && section.signedAt ? (
          <time dateTime={section.signedAt} className="wx-row-sub">
            {shortStamp(section.signedAt)}
          </time>
        ) : null}
      </header>
      {body}
    </section>
  );
}

export interface SignedNoteViewProps {
  readonly view: FinalDocumentationView | null | undefined;
  readonly history: NoteHistory | null | undefined;
  /** What the page shows when the API sent no structured view (an older server, or nothing pinned): never a withheld note's text. */
  readonly fallbackText: string;
}

export function SignedNoteView({ view, history, fallbackText }: SignedNoteViewProps): JSX.Element {
  if (view === null || view === undefined) return <p className="wx-note-text">{fallbackText}</p>;
  if (view.withheld && view.sections.length === 0) return <WithheldNotice scope="note" />;
  return (
    <div className="wx-note">
      {view.sections.map((section, index) => (
        <NoteSectionBlock
          // A pin with no sealed rows has one block with no id; the rest are unique by section id.
          key={section.sectionId ?? `block-${index}`}
          section={section}
          history={history}
        />
      ))}
    </div>
  );
}
