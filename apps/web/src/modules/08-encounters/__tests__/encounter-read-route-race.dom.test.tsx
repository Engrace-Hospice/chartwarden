// @vitest-environment jsdom
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";

const readMocks = vi.hoisted(() => ({ readEncounter: vi.fn() }));

vi.mock("../encounter-read-load", async (importOriginal) => {
  const original = await importOriginal<typeof import("../encounter-read-load")>();
  return { ...original, readEncounter: readMocks.readEncounter };
});

import { EncounterRead } from "../encounter-read";

const ENCOUNTER_A = "11111111-1111-4111-8111-111111111111";
const ENCOUNTER_B = "22222222-2222-4222-8222-222222222222";
const PATIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SIGN_PATH = "/api/v1/encounters/{encounterId}/sign";

const loaded = (
  encounterId: string,
  patientId: string,
  patientName: string,
  visitModality: "in_person" | "video",
  cosignStatus: string | null = null,
) => ({
  ok: true as const,
  encounter: {
    id: encounterId,
    organizationId: "org-1",
    patientId,
    admissionId: `admission-${encounterId}`,
    visitId: `visit-${encounterId}`,
    authoredByUserId: "member-1",
    encounterType: "routine_visit",
    discipline: "rn",
    serviceDate: "2026-11-20",
    status: "finalized",
    lateEntryTier: "normal",
    version: 1,
    isF2f: false,
    signedAt: null,
    cosignedAt: null,
    visitModality,
    visitModalityConfirmed: true,
    evvBracketPresent: true,
    selections: null,
    finalDocumentation: null,
    vitals: null,
    mileage: null,
    carePlanLinks: [],
    addenda: [],
  },
  patient: {
    firstName: patientName,
    lastName: "Patient",
    dob: "1950-01-01",
    mrn: `MRN-${patientName}`,
    status: "active",
  },
  cosignStatus,
  carePlan: { problems: [], goals: [], interventions: [], redacted: false },
  assessments: [],
  hopeAssessments: [],
  noteText: "",
  noteEdited: false,
  vitals: null,
  mileage: null,
});

function OpenEncounterB() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => navigate(`/patients/${PATIENT_B}/encounters/${ENCOUNTER_B}`)}
      >
        Open encounter B
      </button>
      <button
        type="button"
        onClick={() => navigate(`/patients/${PATIENT_B}/encounters/${ENCOUNTER_A}`)}
      >
        Open encounter A under patient B
      </button>
    </>
  );
}

function mount() {
  const get = vi.fn(async () => ({
    error: { error: { code: "NOT_FOUND" } },
    response: new Response(null, { status: 404 }),
  }));
  const post = vi.fn(async () => ({ data: { status: "signed" }, response: new Response() }));
  const patch = vi.fn(async () => ({ data: {}, response: new Response() }));

  render(
    <MemoryRouter initialEntries={[`/patients/${PATIENT_A}/encounters/${ENCOUNTER_A}`]}>
      <ApiClientProvider client={{ GET: get, POST: post, PATCH: patch } as never}>
        <ToastProvider>
          <SessionProvider
            session={{
              userId: "user-1",
              organizationId: "org-1",
              permissions: ["encounter.author", "encounter.finalize", "encounter.sign"],
            }}
          >
            <OpenEncounterB />
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

  return { post };
}

beforeEach(() => {
  readMocks.readEncounter.mockReset();
});

describe("encounter read route identity", () => {
  it("rejects a mixed-patient read when only the patient route parameter changes", async () => {
    let resolveMismatchedRead!: (value: ReturnType<typeof loaded>) => void;
    const mismatchedRead = new Promise<ReturnType<typeof loaded>>((resolve) => {
      resolveMismatchedRead = resolve;
    });
    const encounterA = loaded(ENCOUNTER_A, PATIENT_A, "Alice", "in_person", "hard_cap_reached");
    readMocks.readEncounter.mockResolvedValueOnce(encounterA).mockReturnValueOnce(mismatchedRead);

    mount();
    const user = userEvent.setup();
    expect(await screen.findByText("Alice Patient")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Supervisor release" }));
    expect(await screen.findByRole("dialog", { name: "Supervisor release" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open encounter A under patient B" }));
    expect(screen.queryByText("Alice Patient")).toBeNull();
    expect(screen.queryByText("MRN-Alice")).toBeNull();
    expect(screen.queryByText("Ready for signature")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Supervisor release" })).toBeNull();

    await act(async () => {
      resolveMismatchedRead(encounterA);
      await mismatchedRead;
    });
    expect(
      await screen.findByText("This encounter is not available for this patient."),
    ).toBeInTheDocument();
  });

  it("hides prior patient identity and retires an open cosign ceremony while the next route loads", async () => {
    let resolveB!: (value: ReturnType<typeof loaded>) => void;
    const deferredB = new Promise<ReturnType<typeof loaded>>((resolve) => {
      resolveB = resolve;
    });
    const encounterA = loaded(ENCOUNTER_A, PATIENT_A, "Alice", "in_person", "hard_cap_reached");
    const encounterB = loaded(ENCOUNTER_B, PATIENT_B, "Beatrice", "video");
    readMocks.readEncounter.mockImplementation((_client: unknown, encounterId: string) =>
      encounterId === ENCOUNTER_A ? Promise.resolve(encounterA) : deferredB,
    );

    mount();
    const user = userEvent.setup();
    expect(await screen.findByText("Alice Patient")).toBeInTheDocument();
    expect(screen.getByText("MRN-Alice")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Supervisor release" }));
    const dialog = await screen.findByRole("dialog", { name: "Supervisor release" });
    await user.type(
      within(dialog).getByRole("textbox", { name: /Reason/ }),
      "This reason belongs only to the first encounter record.",
    );

    await user.click(screen.getByRole("button", { name: "Open encounter B" }));
    expect(screen.queryByText("Alice Patient")).toBeNull();
    expect(screen.queryByText("DOB 1950-01-01")).toBeNull();
    expect(screen.queryByText("MRN-Alice")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Supervisor release" })).toBeNull();

    await act(async () => {
      resolveB(encounterB);
      await deferredB;
    });
    expect(await screen.findByText("Beatrice Patient")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Supervisor release" })).toBeNull();
  });

  it("ignores a late prior read and signs only the encounter now in the route", async () => {
    let resolveA!: (value: ReturnType<typeof loaded>) => void;
    const deferredA = new Promise<ReturnType<typeof loaded>>((resolve) => {
      resolveA = resolve;
    });
    const encounterA = loaded(ENCOUNTER_A, PATIENT_A, "Alice", "in_person");
    const encounterB = loaded(ENCOUNTER_B, PATIENT_B, "Beatrice", "video");
    readMocks.readEncounter.mockImplementation((_client: unknown, encounterId: string) =>
      encounterId === ENCOUNTER_A ? deferredA : Promise.resolve(encounterB),
    );

    const { post } = mount();
    const user = userEvent.setup();
    await waitFor(() =>
      expect(readMocks.readEncounter).toHaveBeenCalledWith(expect.anything(), ENCOUNTER_A),
    );

    await user.click(screen.getByRole("button", { name: "Open encounter B" }));
    expect(await screen.findByText("Beatrice Patient")).toBeInTheDocument();

    await act(async () => {
      resolveA(encounterA);
      await deferredA;
    });
    expect(screen.getByText("Beatrice Patient")).toBeInTheDocument();
    expect(screen.queryByText("Alice Patient")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Sign encounter" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign encounter" });
    expect(within(dialog).getByRole("radio", { name: "Video" })).toBeChecked();
    await user.click(within(dialog).getByRole("checkbox", { name: /complete and accurate/i }));
    await user.click(within(dialog).getByRole("button", { name: /sign & commit/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        SIGN_PATH,
        expect.objectContaining({
          params: { path: { encounterId: ENCOUNTER_B } },
          body: expect.objectContaining({ visitModality: "video" }),
        }),
      ),
    );
  });
});
