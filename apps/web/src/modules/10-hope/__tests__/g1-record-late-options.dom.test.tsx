// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeRecordModal } from "../hope-record-modal";
import { SESSION } from "./workspace-test-kit";

// Group g1: a plain late completion is explained by a reason the clinician chooses. "Admin Override" is not one of them: it is
// filed only by the authorized, justified override path, so a late capture can never be labelled with it.

const DAY = 24 * 60 * 60 * 1000;
const lateWindow = () => {
  const now = Date.now();
  return {
    id: "schedule-7",
    rfaKind: "02_huv1" as const,
    windowOpensAt: new Date(now - 10 * DAY).toISOString(),
    windowClosesAt: new Date(now - 3 * DAY).toISOString(),
    lateDeadlineAt: new Date(now + 10 * DAY).toISOString(),
  };
};

describe("late completion reasons", () => {
  it("does not offer Admin Override for a plain late completion, and still offers the real reasons", () => {
    const client = { GET: vi.fn(), POST: vi.fn() } as unknown as ApiClient;
    render(
      <SessionProvider session={SESSION}>
        <ApiClientProvider client={client}>
          <HopeRecordModal
            open
            admissionId="adm-1"
            window={lateWindow()}
            onClose={vi.fn()}
            onDone={vi.fn()}
          />
        </ApiClientProvider>
      </SessionProvider>,
    );
    const dialog = screen.getByRole("dialog", { name: "Record HOPE timepoint" });
    const select = within(dialog).getByLabelText("Late completion reason") as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).not.toContain("Admin Override");
    expect(labels).toContain("Hospitalization");
    expect(labels).toContain("Other");
  });
});
