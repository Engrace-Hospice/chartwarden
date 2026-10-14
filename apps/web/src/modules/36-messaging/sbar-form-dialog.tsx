// M36 WP 3.3 - the SBAR form: four labelled sections, a sender urgency label, and the always-visible emergency-path note.
// Stateless about its text (the thread keeps it, see use-sbar-compose.ts); it builds the RichSbar document and checks it
// with the shared validator so the client says what the server will. Server field errors come in as `serverIssues`.
import { SBAR_SECTION_KEYS, SBAR_SECTION_LABELS, SBAR_URGENCY_HINTS } from "@wardenx/types";
import type { RichBody, SbarIssue, SbarSectionKey } from "@wardenx/types";
import { validateSbar } from "@wardenx/types";
import { Button, Modal } from "@wardenx/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import {
  SBAR_DEFAULT_HINTS,
  SBAR_EMERGENCY_NOTE,
  SBAR_URGENCY_LABEL,
  SBAR_URGENT_NOTE,
  type SbarFormValues,
  buildSbarBody,
  sectionLength,
} from "./sbar-utils";
import type { SbarPolicyView } from "./use-sbar-policy";
import "./sbar.css";

export interface SbarFormDialogProps {
  readonly policy: SbarPolicyView;
  readonly values: SbarFormValues;
  readonly onChange: (values: SbarFormValues) => void;
  readonly sending: boolean;
  /** Field errors from the server's SBAR_INVALID answer. */
  readonly serverIssues: readonly SbarIssue[];
  /** The sender's failure text (network, refused channel, ...). */
  readonly sendError: string | null;
  readonly onSubmit: (body: RichBody) => void;
  /** Close and keep the text. */
  readonly onCancel: () => void;
  /** Close and forget the text. */
  readonly onDiscard: () => void;
}

export function SbarFormDialog({
  policy,
  values,
  onChange,
  sending,
  serverIssues,
  sendError,
  onSubmit,
  onCancel,
  onDiscard,
}: SbarFormDialogProps): JSX.Element {
  const baseId = useId();
  const refs = useRef<Partial<Record<SbarSectionKey, HTMLTextAreaElement | null>>>({});
  const [clientIssues, setClientIssues] = useState<readonly SbarIssue[]>([]);
  // A change since the last server answer makes that answer stale; client checks then speak for themselves.
  const [staleServer, setStaleServer] = useState(false);
  const issues = [...clientIssues, ...(staleServer ? [] : serverIssues)];
  const issueFor = (key: SbarSectionKey) => issues.find((issue) => issue.field === `sbar.${key}`);

  useEffect(() => {
    setStaleServer(false);
    const first = SBAR_SECTION_KEYS.find((key) =>
      serverIssues.some((issue) => issue.field === `sbar.${key}`),
    );
    if (first) refs.current[first]?.focus();
  }, [serverIssues]);

  function submit(): void {
    if (sending) return;
    const body = buildSbarBody(values);
    const found = validateSbar(body, policy);
    setClientIssues(found);
    const first = SBAR_SECTION_KEYS.find((key) => found.some((i) => i.field === `sbar.${key}`));
    if (first) {
      refs.current[first]?.focus();
      return;
    }
    onSubmit(body);
  }

  function onKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    submit();
  }

  const setSection = (key: SbarSectionKey, text: string): void => {
    setClientIssues([]);
    setStaleServer(true);
    onChange({ ...values, sections: { ...values.sections, [key]: text } });
  };

  return (
    <Modal open onClose={sending ? undefined : onCancel} ariaLabel="SBAR message" width="40rem">
      <form
        className="wx-sbar-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        onKeyDown={onKeyDown}
      >
        <header>
          <h2 id={`${baseId}-title`}>SBAR message</h2>
          <p className="wx-sbar-notice" id={`${baseId}-notice`}>
            {SBAR_EMERGENCY_NOTE}
          </p>
        </header>
        {SBAR_SECTION_KEYS.map((key) => {
          const issue = issueFor(key);
          const min = Math.max(policy.minChars[key], 1);
          const length = sectionLength(values, key);
          const hint = policy.hints[key] ?? SBAR_DEFAULT_HINTS[key];
          const ids = `${baseId}-${key}`;
          return (
            <div className="wx-sbar-field" key={key}>
              <label htmlFor={`${ids}-input`}>{SBAR_SECTION_LABELS[key]}</label>
              <textarea
                id={`${ids}-input`}
                ref={(node) => {
                  refs.current[key] = node;
                }}
                rows={3}
                value={values.sections[key]}
                disabled={sending}
                aria-invalid={issue ? true : undefined}
                aria-describedby={`${ids}-hint ${ids}-count${issue ? ` ${ids}-error` : ""}`}
                onChange={(event) => setSection(key, event.target.value)}
              />
              <p className="wx-sbar-hint" id={`${ids}-hint`}>
                {hint}
              </p>
              <p className="wx-sbar-count" id={`${ids}-count`}>
                {length} / {min}
              </p>
              {issue ? (
                <p className="wx-sbar-error" id={`${ids}-error`} role="alert">
                  {SBAR_SECTION_LABELS[key]} {issue.message}
                </p>
              ) : null}
            </div>
          );
        })}
        <fieldset className="wx-sbar-urgency" disabled={sending}>
          <legend>Urgency (a label for the reader only)</legend>
          {SBAR_URGENCY_HINTS.map((hint) => (
            <label key={hint}>
              <input
                type="radio"
                name={`${baseId}-urgency`}
                value={hint}
                checked={values.urgency === hint}
                onChange={() => onChange({ ...values, urgency: hint })}
              />{" "}
              {SBAR_URGENCY_LABEL[hint]}
            </label>
          ))}
          {values.urgency === "urgent" ? (
            <p className="wx-sbar-notice">{SBAR_URGENT_NOTE}</p>
          ) : null}
        </fieldset>
        {sendError ? (
          <p className="wx-sbar-error" role="alert">
            {sendError}
          </p>
        ) : null}
        <div className="wx-sbar-actions">
          <Button type="button" tone="secondary" disabled={sending} onClick={onDiscard}>
            Discard
          </Button>
          <Button type="button" tone="secondary" disabled={sending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={sending}>
            Send SBAR
          </Button>
        </div>
      </form>
    </Modal>
  );
}
