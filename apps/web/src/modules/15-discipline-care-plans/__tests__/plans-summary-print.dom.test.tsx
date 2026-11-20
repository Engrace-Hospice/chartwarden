import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the printable summary hides its own controls when printed.
// `.wx-print-hide` (app-shell.css, inside `@media print`) must sit on a wrapper with NO inline display: the
// Print button and the Back link are page controls, not part of the document a surveyor is handed.
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { DisciplinePlansSummary } from "../plans-summary";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["discipline_plan.read_summary"],
};

describe("discipline plans summary — print", () => {
  it("wraps the Print and Back controls in .wx-print-hide, with no inline display on the wrapper", async () => {
    const ok = (data: unknown) => ({
      data,
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    const client = {
      GET: vi.fn(async (path: string) =>
        path === "/api/v1/patients/{id}"
          ? ok({
              id: "p1",
              organizationId: "org-1",
              mrn: "MRN-0007",
              firstName: "June",
              lastName: "Rivera",
              dob: "1950-02-14",
              status: "active",
            })
          : ok({ data: [], nextCursor: null }),
      ),
    } as unknown as ApiClient;
    render(
      <MemoryRouter initialEntries={["/patients/p1/discipline-plans/summary"]}>
        <ApiClientProvider client={client}>
          <ToastProvider>
            <SessionProvider session={session}>
              <Routes>
                <Route
                  path="/patients/:patientId/discipline-plans/summary"
                  element={<DisciplinePlansSummary />}
                />
              </Routes>
            </SessionProvider>
          </ToastProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const print = await waitFor(() => screen.getByRole("button", { name: "Print" }));
    const wrapper = print.closest(".wx-print-hide") as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.display).toBe("");
    expect(wrapper?.contains(screen.getByRole("link", { name: "Back" }))).toBe(true);
  });
});
