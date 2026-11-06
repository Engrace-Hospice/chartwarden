// apps/web/src/modules/16-bereavement — MailingContentEditor: the agency's own wording of a mailing (ADR-0109 D10).
//
// Used twice: the standing wording of a mailing on the settings screen, and one draft run's wording on the run detail. It is a
// CONTROLLED editor: the parent owns the draft, knows whether it is dirty (`sameWording`) and decides what leaving or saving means.
// What it guarantees itself: nothing is pre-filled (no default wording ships: a blank page stays blank, and Generate refuses it),
// the limits are the server's (`CONTENT_LIMITS`) and are said as they are crossed, and every control goes inert at once while a
// write is in flight (`disabled` is a <fieldset disabled>, so a control added later is covered too).
import { t } from "@chartwarden/ui";
import { useId } from "react";
import type { CSSProperties, JSX } from "react";
import type { MailingLocaleContent } from "./bereavement-api";
import {
  ErrorText,
  TextAreaField,
  TextField,
  ghostButtonStyle,
  mutedStyle,
} from "./bereavement-ui";
import { CONTENT_LIMITS, GREETING_NAME_TOKEN, wordingProblems } from "./mailing-status";

const fieldsetStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: t.space3,
  margin: 0,
  padding: 0,
  border: 0,
  minWidth: 0,
};

export function MailingContentEditor({
  value,
  onChange,
  disabled = false,
  scope,
}: {
  value: MailingLocaleContent;
  onChange: (next: MailingLocaleContent) => void;
  /** A write is in flight (or the reader may not edit): every control is inert. */
  disabled?: boolean;
  /** Prefixes each control's label so two editors on one page stay distinguishable ("Quarterly newsletter title"). */
  scope?: string;
}): JSX.Element {
  const greetingHintId = useId();
  const label = (name: string): string => (scope ? `${scope} ${name}` : capitalize(name));
  const problems = wordingProblems(value);
  const setParagraph = (index: number, text: string): void =>
    onChange({ ...value, paragraphs: value.paragraphs.map((p, i) => (i === index ? text : p)) });

  return (
    <fieldset style={fieldsetStyle} disabled={disabled} aria-busy={disabled}>
      <span style={mutedStyle}>
        Write the letter in your agency's own words. Nothing is filled in for you: a mailing cannot
        be generated until it has a title and at least one paragraph.
      </span>
      <TextField
        label={label("title")}
        value={value.title}
        onChange={(title) => onChange({ ...value, title })}
      />
      <TextField
        label={label("greeting")}
        value={value.greeting}
        describedBy={greetingHintId}
        onChange={(greeting) => onChange({ ...value, greeting })}
      />
      <span id={greetingHintId} style={mutedStyle}>
        Write {GREETING_NAME_TOKEN} where each family member's name should go. A greeting of "Dear{" "}
        {GREETING_NAME_TOKEN}," prints "Dear" followed by that person's name; a blank greeting
        prints just the name.
      </span>
      {value.paragraphs.map((paragraph, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: an editable list of free text with no stable id
        <div key={i} style={{ display: "flex", flexDirection: "column", gap: t.space2 }}>
          <TextAreaField
            label={label(`paragraph ${i + 1}`)}
            value={paragraph}
            rows={4}
            onChange={(text) => setParagraph(i, text)}
            hint={`${paragraph.trim().length} of ${CONTENT_LIMITS.paragraph} characters.`}
          />
          <div>
            <button
              type="button"
              style={ghostButtonStyle}
              aria-label={label(`remove paragraph ${i + 1}`)}
              onClick={() =>
                onChange({ ...value, paragraphs: value.paragraphs.filter((_, j) => j !== i) })
              }
            >
              Remove paragraph {i + 1}
            </button>
          </div>
        </div>
      ))}
      <div>
        <button
          type="button"
          style={ghostButtonStyle}
          disabled={value.paragraphs.length >= CONTENT_LIMITS.paragraphs}
          aria-label={label("add a paragraph")}
          onClick={() => onChange({ ...value, paragraphs: [...value.paragraphs, ""] })}
        >
          Add a paragraph
        </button>
        <span style={{ ...mutedStyle, marginLeft: t.space2 }}>
          {value.paragraphs.length} of {CONTENT_LIMITS.paragraphs} paragraphs
        </span>
      </div>
      <TextField
        label={label("sign-off")}
        value={value.signoff}
        onChange={(signoff) => onChange({ ...value, signoff })}
      />
      {problems.map((problem) => (
        <ErrorText key={problem}>{problem}</ErrorText>
      ))}
    </fieldset>
  );
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
