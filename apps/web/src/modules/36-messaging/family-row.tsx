// M36 WP 6.7 (ADR-0099 D6, D9) - one row of the Family lane: flat, state as words (never colour alone). The main area is the control that opens the thread.
import type { FamilyContactSummaryDto } from "@chartwarden/types";
import { StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { ageText } from "./family-failure";
import { ft } from "./family-text";

export const consentLabel = (c: FamilyContactSummaryDto): string =>
  ft(`family.consent.${c.consentState}`);
export const linkLabel = (c: FamilyContactSummaryDto): string => ft(`family.link.${c.linkState}`);

export function FamilyRow({
  contact,
  selected,
  now,
  onSelect,
}: {
  readonly contact: FamilyContactSummaryDto;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: (contactId: string) => void;
}): JSX.Element {
  return (
    <li className="wx-export-row wx-family-row" data-selected={selected || undefined}>
      <button
        type="button"
        className="wx-family-row-main"
        aria-pressed={selected}
        onClick={() => onSelect(contact.contactId)}
      >
        <span className="wx-export-title">
          {contact.displayName} <span className="wx-export-detail">({contact.relationship})</span>
        </span>
        <span className="wx-export-detail">
          {ft("family.row.for", { patient: contact.patientName })}
        </span>
        <span className="wx-export-detail">
          {ft("family.row.consent", { state: consentLabel(contact) })} ·{" "}
          {ft("family.row.link", { state: linkLabel(contact) })}
        </span>
        <span className="wx-export-detail">
          {contact.unansweredSince
            ? ft("family.row.waiting", { age: ageText(contact.unansweredSince, now) })
            : ft("family.row.nothingWaiting")}{" "}
          ·{" "}
          {contact.language
            ? ft("family.row.language", { language: contact.language })
            : ft("family.row.languageUnknown")}
        </span>
      </button>
      <div className="wx-export-meta">
        {contact.highVolume ? (
          <StatusPill tone="progress" glyph="alert" label={ft("family.chip.highVolume")} />
        ) : null}
        {contact.closed ? <StatusPill tone="neutral" label={ft("family.chip.closed")} /> : null}
        {contact.blocked ? (
          <StatusPill tone="error" glyph="alert" label={ft("family.chip.blocked")} />
        ) : null}
        {contact.mode === "bereavement" ? (
          <StatusPill tone="neutral" label={ft("family.chip.bereavement")} />
        ) : null}
      </div>
    </li>
  );
}
