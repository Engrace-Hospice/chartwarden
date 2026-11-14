import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { NoeAdmissionNoticeStatus } from "../noe-admission-notice-status";

const ADMISSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTICE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function mount(result: unknown) {
  const GET = vi.fn(async () => result);
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET } as unknown as ApiClient}>
        <NoeAdmissionNoticeStatus admissionId={ADMISSION_ID} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return GET;
}

describe("admission NOE context", () => {
  it("shows server-derived deadline risk and distinguishes an internal request from acceptance", async () => {
    const GET = mount({
      data: { items: [{
        noeId: NOTICE_ID,
        state: "submitted",
        electionEffectiveDate: "2026-10-01",
        deadline: {
          risk: "submitted_awaiting_verification", dueDate: "2026-10-06", acceptance: "not_verified",
          lifecycle: "submission_requested",
        },
      }] },
      error: undefined,
    });
    expect(await screen.findByText("Request recorded · not transmitted")).toBeTruthy();
    expect(screen.getByText(/Due 2026-10-06 · submitted awaiting verification/)).toBeTruthy();
    expect(screen.getByText(/not proof of transmission or MAC acceptance/)).toBeTruthy();
    expect(GET).toHaveBeenCalledWith("/api/v1/noe-records", { params: { query: { admissionId: ADMISSION_ID, limit: 1 } } });
  });

  it("renders no notice data when billing permission is refused", async () => {
    mount({ data: undefined, error: { code: "FORBIDDEN" } });
    await Promise.resolve();
    expect(screen.queryByText("Medicare Notice of Election")).toBeNull();
  });
});
