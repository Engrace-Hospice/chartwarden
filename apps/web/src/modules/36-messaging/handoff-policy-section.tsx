// M36 WP 3.5 - handoff expiry for a template manager. A tenant can only shorten the platform maximum; the server refuses
// anything outside the range. Hidden when the viewer cannot read the policy or handoffs are off (the server decides).
import { HANDOFF_EXPIRY_MIN_MINUTES } from "@wardenx/types";
import { Button, InlineAlert, Panel, useApiClient } from "@wardenx/ui";
import { useState } from "react";
import type { FormEvent, JSX } from "react";
import { apiErrorCode } from "./attachment-utils";
import { handoffErrorText } from "./handoff-wording";
import type { HandoffPolicy } from "./use-handoff-compose";
import { useHandoffPolicy } from "./use-handoff-policy";
import "./handoffs.css";

const SAVE_FAILED = "The handoff policy could not be saved. Check your connection and try again.";

function PolicyForm({
  policy,
  onChanged,
}: {
  policy: HandoffPolicy;
  onChanged: () => void;
}): JSX.Element {
  const client = useApiClient();
  const [minutes, setMinutes] = useState(String(policy.expiry_minutes));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState("");

  async function run(
    work: () => Promise<{ error?: unknown; response?: { status: number } }>,
    done: string,
  ): Promise<void> {
    setPending(true);
    setError(null);
    setSaved("");
    try {
      const { error: failure, response } = await work();
      if (failure || (response && response.status >= 400)) {
        setError(handoffErrorText(response?.status, apiErrorCode(failure) ?? undefined));
        return;
      }
      setSaved(done);
      onChanged();
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setPending(false);
    }
  }

  function save(event: FormEvent): void {
    event.preventDefault();
    const value = Number(minutes);
    if (
      !Number.isInteger(value) ||
      value < HANDOFF_EXPIRY_MIN_MINUTES ||
      value > policy.platform_max_minutes
    ) {
      setError(
        `Enter a whole number from ${HANDOFF_EXPIRY_MIN_MINUTES} to ${policy.platform_max_minutes} minutes.`,
      );
      return;
    }
    void run(
      () =>
        client.PUT("/api/v1/messaging/template-admin/handoff-policy", {
          body: { expiry_minutes: value },
        }),
      "Handoff policy saved.",
    );
  }

  return (
    <form aria-label="Handoff policy" noValidate className="wx-handoff-policy" onSubmit={save}>
      <p>
        Offered handoffs that are not accepted in time close and stay with the sender, and a
        supervisor is alerted. The platform maximum is {policy.platform_max_minutes} minutes. You
        can shorten it, not lengthen it.
      </p>
      <label>
        <span>Minutes before an offer expires</span>
        <input
          type="number"
          min={HANDOFF_EXPIRY_MIN_MINUTES}
          max={policy.platform_max_minutes}
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
        />
      </label>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <output aria-live="polite">
        {saved ? <InlineAlert tone="success">{saved}</InlineAlert> : null}
      </output>
      <div className="wx-saved-reply-form-actions">
        <Button type="submit" loading={pending}>
          Save
        </Button>
        {policy.customised ? (
          <Button
            type="button"
            tone="secondary"
            disabled={pending}
            onClick={() =>
              void run(
                () => client.DELETE("/api/v1/messaging/template-admin/handoff-policy"),
                "Handoff policy reset to the platform default.",
              )
            }
          >
            Reset to platform default
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export function HandoffPolicySection(): JSX.Element | null {
  const state = useHandoffPolicy();
  if (state.status !== "ready") return null;
  return (
    <Panel title="Clinical handoffs">
      <PolicyForm
        key={JSON.stringify(state.policy)}
        policy={state.policy}
        onChanged={state.reload}
      />
    </Panel>
  );
}
