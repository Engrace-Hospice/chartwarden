import type { Meta, StoryObj } from "@storybook/react-vite";
// Storybook (R0.5) — Sensitivity & Consent Layer (DESIGN.md §8). Masked identifiers, sealed Part-2
// blocks, the ambient break-glass banner, and consent-gated badges.
import { BreakGlassBanner, ConsentBadge, MaskedIdentifier, SealedBlock } from "@wardenx/ui";
import { type JSX, useState } from "react";

const meta: Meta = { title: "Lantern/Sensitivity" };
export default meta;

function Stack({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.25rem",
        padding: "1.5rem",
        maxWidth: "44rem",
      }}
    >
      {children}
    </div>
  );
}

export const Masked: StoryObj = {
  name: "Masked Identifier",
  render: () => (
    <Stack>
      <div>
        SSN:{" "}
        <MaskedIdentifier
          label="Social Security Number"
          value="123-45-6789"
          onReveal={() => "123-45-6789"}
        />
      </div>
      <div>
        MBI:{" "}
        <MaskedIdentifier
          label="Medicare Beneficiary Identifier"
          value="1EG4-TE5-MK73"
          onReveal={() => "1EG4-TE5-MK73"}
        />
      </div>
      <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
        Read-only (no reveal affordance): <MaskedIdentifier value="987-65-4321" />
      </div>
    </Stack>
  ),
};

export const Sealed: StoryObj = {
  name: "Sealed Block (42 CFR Part 2)",
  render: () => {
    const [unsealed, setUnsealed] = useState(false);
    return (
      <Stack>
        <SealedBlock unsealed={unsealed} onUnseal={() => setUnsealed(true)}>
          <div
            style={{
              padding: "1rem",
              background: "var(--color-surface-low)",
              borderRadius: "0.75rem",
            }}
          >
            SUD treatment note — patient enrolled in MAT program; last buprenorphine dose 06/20.
          </div>
        </SealedBlock>
      </Stack>
    );
  },
};

export const BreakGlass: StoryObj = {
  name: "Break-Glass Banner",
  parameters: { layout: "fullscreen" },
  render: () => (
    <BreakGlassBanner
      grantedTo="Acting as: J. Okafor, RN"
      reason="Reason: after-hours emergency"
      onEndSession={() => {}}
    />
  ),
};

export const ConsentBadges: StoryObj = {
  name: "Consent Badge",
  render: () => (
    <Stack>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <ConsentBadge label="Part 2 protected" authority="42 CFR Part 2 · consent on file" />
        <ConsentBadge label="HIV (Ryan White)" authority="State consent required" />
        <ConsentBadge label="DPOA active" authority="Durable power of attorney — daughter" />
      </div>
    </Stack>
  ),
};
