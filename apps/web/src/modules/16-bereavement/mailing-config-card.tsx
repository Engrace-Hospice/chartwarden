// apps/web/src/modules/16-bereavement — ONE MAILING's standing config on the settings screen (ADR-0109 D10, route 43).
//
// Whether the mailing is sent, how many days ahead its draft run opens, which relationships receive it, the date override (only the
// newsletter and the December card have one) and the agency's own wording. The save carries the config version the screen READ in
// `If-Match` (0 for a mailing never configured). A 412 means someone else saved first: the card says so and offers a reload, which
// discards the unsaved edits, so it is never done for the reader. While the write is in flight every control is inert and the
// button shows it; an unsaved edit is flagged, can be discarded, and the browser warns before the tab is closed over it.
import { Button, StatusPill, t } from "@chartwarden/ui";
import { useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import {
  type BereavementRelationshipCode,
  type MailingConfig,
  errorMessage,
  putMailingConfig,
} from "./bereavement-api";
import { humanize } from "./bereavement-status";
import {
  Card,
  CheckboxField,
  ErrorText,
  Notice,
  TextField,
  mutedStyle,
  useIdempotencyKey,
  visuallyHidden,
} from "./bereavement-ui";
import { buildBody, draftOf, sameDraft } from "./mailing-config-draft";
import { MailingContentEditor } from "./mailing-content-editor";
import {
  AUDIENCE_RELATIONSHIPS,
  LEAD_DAYS_MAX,
  LEAD_DAYS_MIN,
  MAILING_WHEN_HINT,
  isWordingComplete,
  mailingLabel,
  wordingProblems,
} from "./mailing-status";

const PRECONDITION_FAILED = 412;
const CONFIG_MOVED =
  "Someone else saved this mailing's settings after you opened them. Reload to see the latest version; reloading discards your unsaved edits.";

export function MailingConfigCard({
  config,
  readOnly,
  onSaved,
  onReload,
}: {
  config: MailingConfig;
  /** The reader may see the settings but not change them. */
  readOnly: boolean;
  onSaved: (saved: MailingConfig) => void;
  /** Read every config again (the card is rebuilt from what comes back). */
  onReload: () => void;
}): JSX.Element {
  const client = useApiClient();
  const label = mailingLabel(config.mailingKey);
  const baseline = draftOf(config);
  const [draft, setDraft] = useState(baseline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const idempotency = useIdempotencyKey();

  const dirty = !sameDraft(draft, baseline);
  const built = buildBody(config.mailingKey, draft);
  const wordingSentences = new Set(wordingProblems(draft.wording));
  const cardProblems = built.problems.filter((p) => !wordingSentences.has(p));

  // A closed tab or a reload would lose the edit: the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const toggleRelationship = (code: BereavementRelationshipCode, on: boolean): void =>
    setDraft({
      ...draft,
      relationships: on
        ? [...draft.relationships, code]
        : draft.relationships.filter((r) => r !== code),
    });

  const save = async (): Promise<void> => {
    if (built.body === null || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const {
      config: saved,
      error: err,
      status,
    } = await putMailingConfig(
      client,
      config.mailingKey,
      config.version,
      built.body,
      idempotency.keyFor(`${config.version}:${JSON.stringify(built.body)}`),
    );
    idempotency.settle(status);
    inFlight.current = false;
    setBusy(false);
    if (err || !saved) {
      if (status === PRECONDITION_FAILED) setStale(true);
      else setError(errorMessage(err, `The ${label} settings could not be saved.`));
      return;
    }
    onSaved(saved);
  };

  return (
    <section aria-label={`${label} settings`}>
      <Card
        title={label}
        actions={
          <StatusPill
            label={!config.configured ? "Not configured" : config.enabled ? "Enabled" : "Disabled"}
            tone={config.configured && config.enabled ? "success" : "neutral"}
          />
        }
      >
        <span style={mutedStyle}>{MAILING_WHEN_HINT[config.mailingKey]}</span>
        <fieldset
          disabled={busy || readOnly}
          aria-busy={busy}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: t.space3,
            margin: 0,
            padding: 0,
            border: 0,
            minWidth: 0,
          }}
        >
          <CheckboxField
            label="Send this mailing"
            checked={draft.enabled}
            onChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          <TextField
            label="Lead time in days"
            type="number"
            value={draft.leadDays}
            onChange={(leadDays) => setDraft({ ...draft, leadDays })}
          />
          <span style={mutedStyle}>
            The draft run opens this many days before the mailing's date ({LEAD_DAYS_MIN} to{" "}
            {LEAD_DAYS_MAX}).
          </span>
          {config.mailingKey === "newsletter_quarterly" ? (
            <TextField
              label="Issue dates (MM-DD, separated by commas)"
              value={draft.newsletterDates}
              placeholder="01-15, 04-15, 07-15, 10-15"
              onChange={(newsletterDates) => setDraft({ ...draft, newsletterDates })}
            />
          ) : null}
          {config.mailingKey === "holiday_december" ? (
            <TextField
              label="Card date (MM-DD)"
              value={draft.decemberDate}
              placeholder="12-15"
              onChange={(decemberDate) => setDraft({ ...draft, decemberDate })}
            />
          ) : null}
          <CheckboxField
            label="Everyone on the roster"
            checked={draft.everyone}
            onChange={(everyone) => setDraft({ ...draft, everyone })}
          />
          {draft.everyone ? null : (
            <fieldset
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(12rem, 1fr))",
                gap: t.space2,
                margin: 0,
                padding: 0,
                border: 0,
                minWidth: 0,
              }}
            >
              <legend style={visuallyHidden}>{label} audience</legend>
              {AUDIENCE_RELATIONSHIPS.map((code) => (
                <CheckboxField
                  key={code}
                  label={humanize(code)}
                  checked={draft.relationships.includes(code)}
                  onChange={(on) => toggleRelationship(code, on)}
                />
              ))}
            </fieldset>
          )}
          <MailingContentEditor
            scope={label}
            value={draft.wording}
            onChange={(wording) => setDraft({ ...draft, wording })}
            disabled={busy || readOnly}
          />
        </fieldset>
        {draft.enabled && !isWordingComplete(draft.wording) ? (
          <Notice tone="warning">
            This mailing is on but has no wording. Its runs will be drafted blank and cannot be
            generated until a title and at least one paragraph are written.
          </Notice>
        ) : null}
        {dirty && !readOnly ? <Notice tone="info">You have unsaved changes.</Notice> : null}
        {cardProblems.map((problem) => (
          <ErrorText key={problem}>{problem}</ErrorText>
        ))}
        {stale ? (
          <Notice tone="warning">
            {CONFIG_MOVED}{" "}
            <Button size="sm" tone="secondary" onClick={onReload}>
              Reload settings
            </Button>
          </Notice>
        ) : null}
        {error ? <ErrorText>{error}</ErrorText> : null}
        {readOnly ? null : (
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Button
              loading={busy}
              disabled={!dirty || built.body === null}
              onClick={() => void save()}
              aria-label={`Save ${label} settings`}
            >
              {busy ? "Saving…" : "Save settings"}
            </Button>
            {dirty && !busy ? (
              <Button tone="secondary" onClick={() => setDraft(baseline)}>
                Discard changes
              </Button>
            ) : null}
          </div>
        )}
      </Card>
    </section>
  );
}
