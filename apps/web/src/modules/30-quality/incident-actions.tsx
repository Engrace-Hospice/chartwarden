import { Button, useApiClient } from "@wardenx/ui";
// M30 incident lifecycle actions (GAP-048): submit / resolve / close / reopen from the incident detail panel.
// Every write is the existing, typed `/api/v1/quality/incidents/{id}/...` route; the server keeps the final say
// (state machine, `capVerifyAuthority`, resolver-is-not-assignee), so a refusal is shown, never second-guessed.
import { useState } from "react";
import type { JSX } from "react";
import {
  type IncidentActionSpec,
  type IncidentLifecycleAction,
  type IncidentLifecycleState,
  availableIncidentActions,
  incidentActionError,
} from "./incident-lifecycle";

export interface IncidentActionsProps {
  readonly incidentId: string;
  readonly state: IncidentLifecycleState;
  /** Called after a successful write so the parent reloads the incident and its list row. */
  readonly onChanged: () => void;
}

export function IncidentActions({
  incidentId,
  state,
  onChanged,
}: IncidentActionsProps): JSX.Element | null {
  const client = useApiClient();
  const specs = availableIncidentActions(state);
  const [active, setActive] = useState<IncidentActionSpec | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (specs.length === 0) return null;

  const run = async (spec: IncidentActionSpec): Promise<void> => {
    setBusy(true);
    setError(null);
    const status = await send(spec.action, spec.textField ? text.trim() : "");
    setBusy(false);
    if (status !== null) {
      setError(incidentActionError(status));
      return;
    }
    setActive(null);
    setText("");
    onChanged();
  };

  const send = async (action: IncidentLifecycleAction, note: string): Promise<number | null> => {
    const path = { incidentId };
    const result =
      action === "submit"
        ? await client.POST("/api/v1/quality/incidents/{incidentId}/submit", { params: { path } })
        : action === "close"
          ? await client.POST("/api/v1/quality/incidents/{incidentId}/close", { params: { path } })
          : action === "resolve"
            ? await client.POST("/api/v1/quality/incidents/{incidentId}/resolve", {
                params: { path },
                body: { resolutionNote: note },
              })
            : await client.POST("/api/v1/quality/incidents/{incidentId}/reopen", {
                params: { path },
                body: { reopenReason: note },
              });
    return result.error ? (result.response?.status ?? 0) : null;
  };

  const pick = (spec: IncidentActionSpec): void => {
    setError(null);
    if (spec.textField) {
      setActive(spec);
      setText("");
    } else void run(spec);
  };

  return (
    <section
      aria-label="Incident actions"
      style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
    >
      {error ? (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      ) : null}
      {active?.textField ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(active);
          }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <span style={{ fontSize: "0.8rem" }}>{active.textField.label}</span>
            <textarea
              rows={3}
              maxLength={4000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          </label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button type="submit" size="sm" loading={busy} disabled={text.trim().length === 0}>
              {active.label}
            </Button>
            <Button tone="secondary" size="sm" disabled={busy} onClick={() => setActive(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
          {specs.map((spec) => (
            <Button
              key={spec.action}
              tone={spec.action === "reopen" ? "secondary" : "primary"}
              size="sm"
              loading={busy}
              onClick={() => pick(spec)}
            >
              {spec.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

const errorStyle = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};
