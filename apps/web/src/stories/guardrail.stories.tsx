import type { Meta, StoryObj } from "@storybook/react-vite";
// Storybook (R0.5) — The Guardrail System (DESIGN.md §7). Guards, gates, blockers, ceremonies,
// and regulatory clocks in one legible language. The WardenX-defining surface.
import {
  BlockingDialog,
  CeremonyModal,
  CountdownChip,
  type GateItem,
  GateStepper,
  GuardChip,
} from "@wardenx/ui";
import { type JSX, useState } from "react";

const meta: Meta = { title: "Lantern/Guardrail" };
export default meta;

function Stack({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        padding: "1.5rem",
        maxWidth: "40rem",
      }}
    >
      {children}
    </div>
  );
}

const GATES: GateItem[] = [
  {
    id: "f2f",
    label: "Face-to-face encounter recorded",
    status: "complete",
  },
  {
    id: "notes",
    label: "2 unsigned visit notes",
    status: "blocked",
    detail: "Notes from 06/21 and 06/22 must be signed before submission.",
    action: { label: "Review notes", onAction: () => {} },
  },
  {
    id: "cti",
    label: "Certification of terminal illness",
    status: "in-progress",
    action: { label: "Open", onAction: () => {} },
  },
  {
    id: "election",
    label: "Election statement on file",
    status: "not-started",
    action: { label: "Add", onAction: () => {} },
  },
];

export const GuardChips: StoryObj = {
  name: "Guard Chip",
  render: () => (
    <Stack>
      <GuardChip reason="2 unsigned notes block submission" onFix={() => {}} />
      <GuardChip
        tone="error"
        reason="Cap exceeded — override required"
        fixLabel="Resolve"
        onFix={() => {}}
      />
      <GuardChip reason="F2F encounter missing" />
    </Stack>
  ),
};

export const Countdowns: StoryObj = {
  name: "Countdown Chip",
  render: () => {
    const now = new Date("2026-06-24T12:00:00Z");
    const at = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
    return (
      <Stack>
        <CountdownChip label="Recert" dueAt={at(120)} now={now} />
        <CountdownChip label="F2F" dueAt={at(30)} now={now} />
        <CountdownChip label="Verbal order" dueAt={at(6)} now={now} />
        <CountdownChip label="NOE" dueAt={at(-8)} now={now} />
      </Stack>
    );
  },
};

export const Gates: StoryObj = {
  name: "Gate Stepper",
  render: () => (
    <Stack>
      <GateStepper items={GATES} />
    </Stack>
  ),
};

export const Blocking: StoryObj = {
  name: "Blocking Dialog",
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <Stack>
        <button type="button" onClick={() => setOpen(true)}>
          Open blocking dialog
        </button>
        <BlockingDialog
          open={open}
          title="Claim cannot be submitted"
          invariants={GATES}
          overrideAllowed
          onOverride={() => setOpen(false)}
          onClose={() => setOpen(false)}
        />
      </Stack>
    );
  },
};

export const Ceremony: StoryObj = {
  name: "Signature Ceremony",
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <Stack>
        <button type="button" onClick={() => setOpen(true)}>
          Open ceremony
        </button>
        <CeremonyModal
          open={open}
          title="Sign order"
          attestation={
            <div>
              <strong>Morphine sulfate 10 mg/5 mL</strong> — 5 mg PO q4h PRN pain. Patient: Eleanor
              Whitfield (MRN-0042817).
            </div>
          }
          legalText="I attest that this order is medically necessary and authorized under my license."
          signer={{ name: "Dr. A. Reyes", role: "Attending Physician" }}
          stepUp={{ label: "Re-enter your password to sign", type: "password" }}
          onCommit={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Stack>
    );
  },
};

export const EpcsCeremony: StoryObj = {
  name: "Signature Ceremony — EPCS",
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <Stack>
        <button type="button" onClick={() => setOpen(true)}>
          Open EPCS ceremony
        </button>
        <CeremonyModal
          open={open}
          epcs
          title="EPCS — controlled substance"
          attestation={
            <div>
              <strong>Oxycodone 5 mg</strong> — 1 tab PO q6h PRN. Schedule II. This is a legally
              binding electronic prescription for a controlled substance.
            </div>
          }
          legalText="By completing this two-factor signature I am issuing this prescription per DEA EPCS requirements."
          signer={{ name: "Dr. A. Reyes", role: "DEA# BR1234567" }}
          stepUp={{ label: "Enter your one-time token", type: "text", placeholder: "OTP" }}
          commitLabel="Sign prescription"
          onCommit={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Stack>
    );
  },
};
