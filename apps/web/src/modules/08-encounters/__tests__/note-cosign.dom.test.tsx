// @vitest-environment jsdom
// The NOTE's cosignature on the encounter page: the quick action each request status offers, and that the ceremony (now the one shared with an
// amendment's request, ADR-0114 VN-D30, S1 PR E4) still reaches the note's own routes. Synthetic data only.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { EncounterRead } from "../encounter-read";

afterEach(cleanup);

const encounter = {
  id: "enc-1",
  organizationId: "org-1",
  patientId: "patient-1",
  admissionId: "admission-1",
  visitId: null,
  encounterType: "lpn_visit",
  discipline: "lpn",
  serviceDate: "2026-11-15",
  status: "cosign_pending",
  lateEntryTier: "normal",
  version: 3,
  authoredByUserId: "mem-lpn",
  isF2f: false,
  signedAt: "2026-11-15T10:00:00Z",
  cosignedAt: null,
  selections: null,
  finalDocumentation: "Visit went well.",
  vitals: null,
  mileage: null,
  carePlanLinks: [],
  addenda: [],
};

const NOTE_COSIGN = "/api/v1/encounters/{encounterId}/cosignature";

function mount(
  requestStatus: string | null,
  post = vi.fn(async () => ({ data: { status: "x" } })),
) {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/encounters/{encounterId}") return { data: encounter };
    if (path === NOTE_COSIGN) return { data: { status: requestStatus } };
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
    return { data: { assessments: [] } };
  });
  render(
    <MemoryRouter initialEntries={["/patients/patient-1/encounters/enc-1"]}>
      <ApiClientProvider client={{ GET, POST: post, PATCH: vi.fn() } as never}>
        <ToastProvider>
          <SessionProvider
            session={{
              userId: "user-1",
              organizationId: "org-1",
              permissions: ["encounter.cosign"],
            }}
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
  return { GET, post, user: userEvent.setup() };
}

const quickAction = async (name: string) => screen.findByRole("button", { name });
const reads = (GET: ReturnType<typeof mount>["GET"]) =>
  GET.mock.calls.filter(([path]) => path === NOTE_COSIGN).length;

describe("the note's cosignature quick actions", () => {
  it.each([
    ["routed", "Acknowledge cosignature", ["Sign cosignature", "Supervisor release"]],
    ["acknowledged", "Sign cosignature", ["Acknowledge cosignature", "Supervisor release"]],
    ["escalated", "Sign cosignature", ["Acknowledge cosignature", "Supervisor release"]],
    ["hard_cap_reached", "Supervisor release", ["Acknowledge cosignature", "Sign cosignature"]],
    ["supervisor_released", "Sign cosignature", ["Acknowledge cosignature", "Supervisor release"]],
  ])("a %s request offers %s and nothing else", async (status, offered, withheld) => {
    mount(status);
    expect(await quickAction(offered)).toBeInTheDocument();
    for (const name of withheld) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("offers no cosignature step when there is no request", async () => {
    mount(null);
    await screen.findByText("No request");
    for (const name of ["Acknowledge cosignature", "Sign cosignature", "Supervisor release"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

describe("the note's cosignature ceremony", () => {
  it("acknowledges through the note's own route and reads the request and page again", async () => {
    const { GET, post, user } = mount("routed");
    await user.click(await quickAction("Acknowledge cosignature"));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Acknowledge" }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`${NOTE_COSIGN}/acknowledge`, {
        params: { path: { encounterId: "enc-1" } },
      }),
    );
    await waitFor(() => expect(reads(GET)).toBe(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("signs the cosignature with the attestation through the note's own route", async () => {
    const { post, user } = mount("acknowledged");
    await user.click(await quickAction("Sign cosignature"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Cosign Lpn Visit")).toBeInTheDocument();
    expect(within(dialog).getByText("2026-11-15")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Sign & commit" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`${NOTE_COSIGN}/sign`, {
        params: { path: { encounterId: "enc-1" } },
        body: { attestationConfirmed: true },
      }),
    );
  });

  it("releases through the note's own route with a reason of 40 characters", async () => {
    const { post, user } = mount("hard_cap_reached");
    await user.click(await quickAction("Supervisor release"));
    const dialog = screen.getByRole("dialog");
    await user.type(
      within(dialog).getByRole("textbox", { name: /reason/i }),
      "The cosigner was on leave past the cap, so I am releasing this for the cover RN.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, init] = post.mock.calls[0] as unknown as [string, { body: { reason: string } }];
    expect(path).toBe(`${NOTE_COSIGN}/supervisor-release`);
    expect(init.body.reason).toMatch(/^The cosigner was on leave/);
  });

  it("words a refusal with the next step, in the dialog", async () => {
    const { user } = mount(
      "acknowledged",
      vi.fn(async () => ({
        error: { error: { code: "COSIGNATURE_LOCKED", message: "x" } },
        response: { status: 409 },
      })) as never,
    );
    await user.click(await quickAction("Sign cosignature"));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Sign & commit" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/locked at the 48-hour cap/);
  });
});
