// Storybook (R0.5) — Provenance & AI Governance Layer (DESIGN.md §9). AI suggestions are marked,
// cited, and require a human action; system-derived content is a quiet factual chip.
import { AiSuggestionCard, DerivedBadge } from "@chartwarden/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JSX } from "react";

const meta: Meta = { title: "Lantern/Provenance" };
export default meta;

function Stack({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
        padding: "1.5rem",
        maxWidth: "40rem",
      }}
    >
      {children}
    </div>
  );
}

export const AiSuggestion: StoryObj = {
  name: "AI Suggestion Card",
  render: () => (
    <Stack>
      <AiSuggestionCard
        model="Clinical Copilot · claude-opus"
        confidence={0.92}
        citation={{ label: "Cited: HOPE assessment 06/22, ESAS-r", onClick: () => {} }}
        onAccept={() => {}}
        onEdit={() => {}}
        onDismiss={() => {}}
      >
        Consider adding a PRN order for breakthrough pain — ESAS-r pain score rose from 3 to 7 over
        the last two visits, and current MME coverage appears insufficient overnight.
      </AiSuggestionCard>
    </Stack>
  ),
};

export const AiSuggestionStatic: StoryObj = {
  name: "AI Suggestion Card — static halo",
  render: () => (
    <Stack>
      <AiSuggestionCard
        staticHalo
        model="WardenLens extraction"
        confidence="high"
        onAccept={() => {}}
        onDismiss={() => {}}
      >
        Extracted referral diagnosis: <strong>C34.90 — Malignant neoplasm of lung</strong>.
      </AiSuggestionCard>
    </Stack>
  ),
};

export const Derived: StoryObj = {
  name: "Derived Badge",
  render: () => (
    <Stack>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <DerivedBadge source="HL7 ADT" verb="imported via" />
        <DerivedBadge source="census rules" verb="computed from" />
        <DerivedBadge source="NPPES" />
      </div>
    </Stack>
  ),
};
