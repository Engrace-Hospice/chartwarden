// M36 WP 3.3 - SBAR policy for a template manager: raise each section's minimum length, require a care-team
// conversation, and re-word the per-section guidance. A tenant can only tighten: the platform floor (1 character per
// section) is the lowest value offered, and the server refuses anything under it. Hidden when the viewer may not manage
// templates (403) or SBAR is off for the organization (404); the server decides, this never infers a permission.
import { SBAR_PLATFORM_FLOOR, SBAR_SECTION_KEYS, SBAR_SECTION_LABELS } from "@wardenx/types";
import type { SbarSectionKey } from "@wardenx/types";
import { Button, InlineAlert, Panel, useApiClient } from "@wardenx/ui";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { apiErrorCode } from "./attachment-utils";
import { apiErrorMessage } from "./messaging-utils";
import { SBAR_DEFAULT_HINTS } from "./sbar-utils";
import { type SbarPolicyView, sbarPolicyClient, useSbarPolicy } from "./use-sbar-policy";
import "./sbar.css";

const MAX_MIN_CHARS = 500;
const MAX_HINT_CHARS = 200;
const SAVE_FAILED = "The SBAR policy could not be saved. Check your connection and try again.";
const FLOOR_TEXT = `Each section needs at least ${SBAR_PLATFORM_FLOOR.minChars.situation} character. You can raise this, not lower it.`;

type Draft = {
  readonly minChars: Readonly<Record<SbarSectionKey, string>>;
  readonly hints: Readonly<Record<SbarSectionKey, string>>;
  readonly requirePatientChannel: boolean;
};

const draftOf = (policy: SbarPolicyView): Draft => ({
  minChars: Object.fromEntries(
    SBAR_SECTION_KEYS.map((k) => [k, String(policy.minChars[k])]),
  ) as Draft["minChars"],
  hints: Object.fromEntries(
    SBAR_SECTION_KEYS.map((k) => [k, policy.hints[k] ?? ""]),
  ) as Draft["hints"],
  requirePatientChannel: policy.requirePatientChannel,
});

function PolicyForm({
  policy,
  onChanged,
  saved,
  setSaved,
}: {
  policy: SbarPolicyView;
  onChanged: () => void;
  /** Held by the section: the form remounts when the reload brings the stored policy back. */
  saved: boolean;
  setSaved: (saved: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(policy));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => ReturnType<ReturnType<typeof sbarPolicyClient>["PUT"]>) {
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const { error: failure, response } = await work();
      if (failure || (response && response.status >= 400)) {
        setError(
          apiErrorCode(failure) === "SBAR_POLICY_FLOOR_VIOLATION"
            ? FLOOR_TEXT
            : apiErrorMessage(failure, SAVE_FAILED),
        );
        return false;
      }
      onChanged();
      return true;
    } catch {
      setError(SAVE_FAILED);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    const minChars = {} as Record<SbarSectionKey, number>;
    const hints = {} as Record<SbarSectionKey, string>;
    for (const key of SBAR_SECTION_KEYS) {
      const value = Number(draft.minChars[key]);
      if (
        !Number.isInteger(value) ||
        value < SBAR_PLATFORM_FLOOR.minChars[key] ||
        value > MAX_MIN_CHARS
      ) {
        setError(FLOOR_TEXT);
        return;
      }
      minChars[key] = value;
      if (draft.hints[key].trim()) hints[key] = draft.hints[key].trim();
    }
    const ok = await run(() =>
      sbarPolicyClient(client).PUT("/api/v1/messaging/template-admin/sbar-policy", {
        body: { minChars, requirePatientChannel: draft.requirePatientChannel, hints },
      }),
    );
    if (ok) setSaved(true);
  }

  async function reset(): Promise<void> {
    const ok = await run(() =>
      sbarPolicyClient(client).DELETE("/api/v1/messaging/template-admin/sbar-policy"),
    );
    if (ok)
      setDraft(
        draftOf({
          ...policy,
          minChars: SBAR_PLATFORM_FLOOR.minChars,
          hints: {},
          requirePatientChannel: false,
        }),
      );
  }

  return (
    <form
      aria-label="SBAR policy"
      onSubmit={(event) => void save(event)}
      className="wx-sbar-policy"
    >
      <p>{FLOOR_TEXT}</p>
      <div className="wx-sbar-policy-grid">
        {SBAR_SECTION_KEYS.map((key) => (
          <div key={key}>
            <label>
              <span>{SBAR_SECTION_LABELS[key]} minimum length</span>
              <input
                type="number"
                min={SBAR_PLATFORM_FLOOR.minChars[key]}
                max={MAX_MIN_CHARS}
                value={draft.minChars[key]}
                onChange={(e) =>
                  setDraft({ ...draft, minChars: { ...draft.minChars, [key]: e.target.value } })
                }
              />
            </label>
            <label>
              <span>{SBAR_SECTION_LABELS[key]} guidance</span>
              <input
                type="text"
                maxLength={MAX_HINT_CHARS}
                placeholder={SBAR_DEFAULT_HINTS[key]}
                value={draft.hints[key]}
                onChange={(e) =>
                  setDraft({ ...draft, hints: { ...draft.hints, [key]: e.target.value } })
                }
              />
            </label>
          </div>
        ))}
      </div>
      <label>
        <input
          type="checkbox"
          checked={draft.requirePatientChannel}
          onChange={(e) => setDraft({ ...draft, requirePatientChannel: e.target.checked })}
        />{" "}
        Only allow SBAR in care-team (patient) conversations
      </label>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {saved ? <InlineAlert tone="success">SBAR policy saved.</InlineAlert> : null}
      <div className="wx-saved-reply-form-actions">
        <Button type="submit" loading={pending}>
          Save
        </Button>
        {policy.customized ? (
          <Button type="button" tone="secondary" disabled={pending} onClick={() => void reset()}>
            Reset to platform defaults
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function SbarPolicySection(): JSX.Element | null {
  const state = useSbarPolicy(true);
  const [saved, setSaved] = useState(false);
  if (state.status !== "ready") return null;
  return (
    <Panel title="SBAR messages">
      <PolicyForm
        key={JSON.stringify(state.policy)}
        policy={state.policy}
        onChanged={state.reload}
        saved={saved}
        setSaved={setSaved}
      />
    </Panel>
  );
}
