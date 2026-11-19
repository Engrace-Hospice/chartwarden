// @vitest-environment jsdom
// On the real encounter page, signing an amending addendum re-reads the encounter; the sentence that says what the sign did (sections
// amended, cosignature requested) must still be on the page after that read, and the page must not blank to a spinner in between (ADR-0114
// VN-D30, S1 React review). Synthetic data only.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EncounterRead } from "../encounter-read";

afterEach(cleanup);

const ENCOUNTER = "/api/v1/encounters/{encounterId}";
const ADDENDUM_DRAFT = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/draft";
const SIGN = "/api/v1/encounters/{encounterId}/addenda/{addendumId}/sign";

const finalized = {
  id: "add-1",
  status: "finalized",
  reason: "Pain pattern changed after the family call",
  authoredByUserId: "mem-author",
  createdAt: "2026-10-01T10:00:00Z",
  signedAt: null,
  version: 0,
  amendsSectionIds: ["pain"],
};

const signedEncounter = (addendum: Record<string, unknown>) => ({
  id: "enc-1",
  organizationId: "org-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  visitId: "visit-1",
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-08-31",
  status: "signed",
  lateEntryTier: "normal",
  version: 2,
  authoredByUserId: "mem-1",
  isF2f: false,
  signedAt: "2026-09-01T10:00:00Z",
  cosignedAt: null,
  selections: null,
  finalDocumentation: "Signed note.",
  vitals: null,
  mileage: null,
  carePlanLinks: [],
  addenda: [addendum],
  visitModality: "telephonic",
  visitModalityConfirmed: true,
  timeSource: null,
  evvBracketPresent: true,
});

function mount() {
  let addendum: Record<string, unknown> = finalized;
  const GET = vi.fn(async (path: string) => {
    if (path === ENCOUNTER) return { data: signedEncounter(addendum) };
    if (path === "/api/v1/encounters/{encounterId}/cosignature") return { data: { status: null } };
    if (path === "/api/v1/patients/{id}") {
      return {
        data: {
          firstName: "Ava",
          lastName: "Stone",
          dob: "1950-01-01",
          mrn: "MRN1",
          status: "active",
        },
      };
    }
    if (path === "/api/v1/internal/care-plan/relevant-elements") {
      return { data: { problems: [], goals: [], interventions: [], redacted: false } };
    }
    if (path === ADDENDUM_DRAFT) {
      return {
        data: {
          addendumId: "add-1",
          encounterId: "enc-1",
          patientId: "patient-1",
          templateKey: "routine_visit:rn",
          asOf: "2026-08-31T23:59:59.999Z",
          sections: [
            {
              sectionId: "pain",
              state: "confirmed",
              text: "Redrafted pain.",
              contentHash: "hash-pain",
              corpusVersion: "2026.1.0",
              part2Derived: false,
              origins: ["vitals"],
            },
          ],
        },
      };
    }
    if (path === "/api/v1/encounters/{encounterId}/draft") {
      return {
        error: { error: { code: "NOT_FOUND", message: "not found" } },
        response: new Response(null, { status: 404 }),
      };
    }
    return { data: { assessments: [] } };
  });
  const POST = vi.fn(async (path: string) => {
    if (path !== SIGN) return { data: {} };
    addendum = { ...finalized, status: "signed", signedAt: "2026-10-02T10:00:00Z" };
    return {
      data: { status: "signed", amendedSectionIds: ["pain"], cosignatureRequestId: "req-1" },
    };
  });
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider client={{ GET, PATCH: vi.fn(), POST } as never}>
        <ToastProvider>
          <SessionProvider
            session={{ userId: "user-1", organizationId: "org-1", permissions: ["encounter.read"] }}
          >
            <Routes>
              <Route
                path="/patients/:patientId/encounters/:encounterId"
                element={<EncounterRead />}
              />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST };
}

const encounterReads = (GET: ReturnType<typeof mount>["GET"]) =>
  GET.mock.calls.filter(([path]) => path === ENCOUNTER).length;

describe("signing an amending addendum on the encounter page", () => {
  it("still says what the sign did once the encounter has been read again", async () => {
    const user = userEvent.setup();
    const { GET } = mount();
    const row = await screen.findByLabelText("Addendum add-1");
    const sign = await within(row).findByRole("button", { name: "Sign addendum" });
    await waitFor(() => expect(sign).not.toHaveAttribute("aria-disabled"));
    await user.click(sign);
    await user.click(screen.getByLabelText(/I attest this addendum/));
    await user.click(screen.getByRole("button", { name: "Sign & commit" }));
    await waitFor(() => expect(encounterReads(GET)).toBe(2));
    expect(
      await screen.findByText(
        "Addendum signed. 1 section amended. A cosignature was requested for this amendment.",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Addendum add-1")).queryByRole("button", {
        name: "Sign addendum",
      }),
    ).toBeNull();
  });

  it("reads the encounter again in place, without replacing the page by a spinner", async () => {
    const user = userEvent.setup();
    const { GET } = mount();
    const row = await screen.findByLabelText("Addendum add-1");
    const sign = await within(row).findByRole("button", { name: "Sign addendum" });
    await waitFor(() => expect(sign).not.toHaveAttribute("aria-disabled"));
    await user.click(sign);
    await user.click(screen.getByLabelText(/I attest this addendum/));
    await user.click(screen.getByRole("button", { name: "Sign & commit" }));
    await waitFor(() => expect(encounterReads(GET)).toBe(2));
    expect(screen.getByLabelText("Addendum add-1")).toBe(row);
  });
});
