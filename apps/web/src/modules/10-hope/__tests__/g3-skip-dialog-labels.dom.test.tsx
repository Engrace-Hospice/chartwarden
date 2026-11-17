// @vitest-environment jsdom
import { HOPE_SCHEDULE_SKIP_REASON_CODES } from "@chartwarden/types";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HopeActionModal } from "../hope-action-modal";
import { ok } from "./workspace-test-kit";

// Group g3: the skip dialog's reasons are worded for a clinician (as the cancel dialog's are), not derived from the code by
// replacing underscores ("Patient Revoked", "Duplicate Window"). The values sent stay the server's closed codes.

afterEach(cleanup);

const LABELS: Readonly<Record<(typeof HOPE_SCHEDULE_SKIP_REASON_CODES)[number], string>> = {
  patient_deceased: "Patient died",
  patient_revoked: "Patient revoked the hospice benefit",
  patient_hospitalized: "Patient was hospitalized",
  transferred_out: "Patient transferred out",
  admission_discharged: "Admission was discharged",
  duplicate_window: "Duplicate timepoint window",
  other: "Other reason",
};

function mount(post: ReturnType<typeof vi.fn>) {
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <HopeActionModal
        open
        action="skip"
        targetId="schedule-1"
        onClose={vi.fn()}
        onDone={vi.fn()}
      />
    </ApiClientProvider>,
  );
  return screen.getByRole("dialog", { name: "Skip timepoint window" });
}

describe("the skip dialog's reasons", () => {
  it("offers every server code, in a clinician's words, and nothing the server does not accept", () => {
    const dialog = mount(vi.fn());
    const reason = within(dialog).getByLabelText(/Reason/) as HTMLSelectElement;

    const offered = within(reason)
      .getAllByRole("option")
      .map((o) => [(o as HTMLOptionElement).value, o.textContent]);

    expect(offered).toEqual([
      ["", "Select a reason"],
      ...HOPE_SCHEDULE_SKIP_REASON_CODES.map((code) => [code, LABELS[code]]),
    ]);
  });

  it("still sends the code, not the words", async () => {
    const post = vi.fn(async () => ok({ id: "schedule-1" }));
    const dialog = mount(post);

    fireEvent.change(within(dialog).getByLabelText(/Reason/), {
      target: { value: "patient_revoked" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Skip window" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body).toEqual({ reasonCode: "patient_revoked" });
  });
});
