import { Modal, StatusPill, useApiClient } from "@wardenx/ui";
// apps/web/src/modules/32-ai-platform — M32 §5.5 `AIReportButton` (GAP-049).
//
// The widget consumer modules render adjacent to any AI-enhanced UI region so a clinician can report a
// wrong answer at the moment they see it. Click opens a modal: severity, classification, narrative.
//
// WHERE IT LIVES. §5.5 proposes a `packages/ai-platform-ui` package. It is exported from M32's own web
// slice instead: every consumer is a web module in this same app, a new workspace package would need a
// manifest codePath and a scaffold-parity entry to hold one component, and ADR-0030's rule is that a
// module owns its own frontend slice. Consumers import it as
// `import { AIReportButton } from "../32-ai-platform"` — one module boundary, same as any other seam.
//
// THE PLACEHOLDER IS LOAD-BEARING. §5.5 is explicit that the narrative must not carry PHI — the linked
// invocation already captures the chart context, and this free text is the field most likely to leak the
// very identifiers the report is about. The placeholder says so, and the 1000-character cap the route
// enforces is enforced in the textarea too, so a clinician learns the limit before losing their text.
//
// `invocationId` IS NULLABLE, by design (§3.2.10): the reports that matter most are often the ones where
// provenance is already broken and the clinician cannot name the call. The widget passes `null` rather
// than refusing to file.
import { useState } from "react";
import type { CSSProperties, JSX } from "react";

const SEVERITIES = [
  { value: "low", hint: "Wrong, but nobody would act on it." },
  { value: "medium", hint: "Wrong in a way that could waste clinical time." },
  { value: "high", hint: "Wrong in a way that could change a clinical decision." },
  { value: "critical", hint: "Wrong in a way that could harm a patient. Raises a SEV-1." },
] as const;

/** `ai_hallucination_kind`. `other` is the default — a clinician should not have to classify to file. */
const KINDS = [
  "other",
  "fabricated_medication",
  "misattributed_symptom",
  "fake_diagnosis",
  "fabricated_quote",
  "misquoted_patient",
  "wrong_dose",
  "fake_clinical_recommendation",
] as const;

const NARRATIVE_MAX = 1000;

const cap = (s: string): string => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const fieldStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  borderRadius: "var(--radius-md, 0.5rem)",
  border: "1px solid var(--color-outline)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  width: "100%",
};

export interface AIReportButtonProps {
  /** The invocation being reported. `null` when the surface cannot name the call it rendered. */
  invocationId: string | null;
  /** The capability's registry id (not its key — R18 keys on the id). */
  capabilityId: string;
  /** The provider entity the reporting clinician is acting under (R18 requires it). */
  providerEntityId: string;
  /** Rendered on the trigger; defaults to the §5.5 label. */
  triggerLabel?: string;
  size?: "sm" | "md";
  variant?: "ghost" | "outline";
}

export function AIReportButton({
  invocationId,
  capabilityId,
  providerEntityId,
  triggerLabel = "Report AI issue",
  size = "sm",
  variant = "ghost",
}: AIReportButtonProps): JSX.Element {
  const client = useApiClient();
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<string>("medium");
  const [kind, setKind] = useState<string>("other");
  const [narrative, setNarrative] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    const res = await client.POST("/api/v1/ai/hallucination-reports", {
      body: {
        capabilityId,
        invocationId,
        severity: severity as never,
        hallucinationKind: kind as never,
        reporterNarrative: narrative.trim(),
        providerEntityId,
      },
    });
    setBusy(false);
    if (res.error) {
      setOutcome({ ok: false, message: "Could not file the report." });
      return;
    }
    setOutcome({ ok: true, message: "Reported — the AI safety team has been notified." });
    setOpen(false);
    setNarrative("");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={triggerLabel}
        style={{
          padding: size === "sm" ? "0.25rem 0.5rem" : "0.5rem 0.9rem",
          fontSize: size === "sm" ? "0.75rem" : "0.85rem",
          borderRadius: "var(--radius-md, 0.5rem)",
          border: variant === "outline" ? "1px solid var(--color-outline)" : "none",
          background: "transparent",
          color: "var(--color-on-surface-variant)",
          cursor: "pointer",
        }}
      >
        {triggerLabel}
      </button>
      {outcome ? (
        <output aria-live="polite">
          <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
        </output>
      ) : null}
      {open ? (
        <Modal open ariaLabel="Report an AI issue" onClose={() => setOpen(false)} width="34rem">
          <div
            style={{ display: "flex", flexDirection: "column", gap: "0.8rem", padding: "0.5rem" }}
          >
            <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Report an AI issue</h2>
            {invocationId === null ? (
              // Said plainly: a report without a linked call is still worth filing, and the triager
              // needs to know why the provenance link is missing.
              <span style={{ fontSize: "0.78rem", color: "var(--color-on-surface-variant)" }}>
                This surface could not identify the AI call it rendered, so the report will not be
                linked to one. File it anyway — an unlinked report is still evidence.
              </span>
            ) : null}
            <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
              <legend style={{ fontSize: "0.85rem", fontWeight: 500 }}>How serious is it?</legend>
              {SEVERITIES.map((s) => (
                <label
                  key={s.value}
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    fontSize: "0.85rem",
                    padding: "0.2rem 0",
                  }}
                >
                  <input
                    type="radio"
                    name="ai-report-severity"
                    value={s.value}
                    checked={severity === s.value}
                    onChange={() => setSeverity(s.value)}
                  />
                  <span>
                    {cap(s.value)} —{" "}
                    <span style={{ color: "var(--color-on-surface-variant)" }}>{s.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.3rem",
                fontSize: "0.85rem",
              }}
            >
              <span>What kind of problem?</span>
              <select value={kind} onChange={(e) => setKind(e.target.value)} style={fieldStyle}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k === "other" ? "Not sure / other" : cap(k)}
                  </option>
                ))}
              </select>
            </label>
            <label
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.3rem",
                fontSize: "0.85rem",
              }}
            >
              <span>
                What went wrong? ({narrative.length}/{NARRATIVE_MAX})
              </span>
              <textarea
                value={narrative}
                onChange={(e) => setNarrative(e.target.value.slice(0, NARRATIVE_MAX))}
                rows={5}
                style={fieldStyle}
                placeholder="Describe what went wrong. Do NOT include patient identifiers — the linked AI call already captures the chart context."
              />
            </label>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || narrative.trim().length === 0}
                style={{
                  padding: "0.55rem 1.1rem",
                  borderRadius: "var(--radius-md, 0.5rem)",
                  border: "none",
                  background: "var(--color-primary)",
                  color: "var(--color-on-primary)",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  cursor: busy ? "default" : "pointer",
                  opacity: busy || narrative.trim().length === 0 ? 0.55 : 1,
                }}
              >
                {busy ? "Filing…" : "File report"}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  padding: "0.55rem 1.1rem",
                  borderRadius: "var(--radius-md, 0.5rem)",
                  border: "1px solid var(--color-outline)",
                  background: "transparent",
                  color: "var(--color-primary)",
                  fontSize: "0.875rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
