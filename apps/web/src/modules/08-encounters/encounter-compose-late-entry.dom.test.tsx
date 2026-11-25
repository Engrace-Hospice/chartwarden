// @vitest-environment jsdom
// The late-entry reason in the visit-note composer (Module 8 section 2.5): where the author writes WHY a note is entered late. The box is up
// before Finalize is pressed when the note is late by the shared ladder, answers the server's 422 LATE_ENTRY_REASON_REQUIRED in plain
// words (no raw sentence, no bare "Action needed"), keeps what was typed, finalizes with the reason, and never leaves the green
// "Required documentation is complete" card as the last word beside an unmet reason. Synthetic data only.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { type Call, type Responder, makeFetch } from "./__tests__/closure-test-harness";
import { EncounterCompose } from "./encounter-compose";
import { LATE_ENTRY_REASON_MIN_CHARS, localCalendarDay } from "./late-entry-reason";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const BASE = `/api/v1/encounters/${ENCOUNTER}`;
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions: [],
  isAdmin: false,
};
const TEMPLATE = {
  encounterId: ENCOUNTER,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    {
      sectionId: "assessment",
      heading: "Assessment",
      required: false,
      allowedCategories: [],
      entries: [],
      recordedPanel: null,
    },
  ],
};
const LONG_REASON = "The patient's family needed me at the bedside until late that evening.";
const SERVER_SENTENCE = "late entry (tier 'significant_late_entry') requires a reason";

const daysAgo = (days: number): string => {
  const day = new Date();
  day.setDate(day.getDate() - days);
  return localCalendarDay(day);
};

let status: "draft" | "finalized";
let serviceDate: string;
let calls: Call[];
let finalizeAnswer: Responder;

const refuseLateEntry: Responder = () => ({
  status: 422,
  body: {
    error: {
      code: "LATE_ENTRY_REASON_REQUIRED",
      message: `${SERVER_SENTENCE} >= ${LATE_ENTRY_REASON_MIN_CHARS} characters`,
    },
  },
});
const acceptFinalize: Responder = () => {
  status = "finalized";
  return { body: { status: "finalized", version: 5 } };
};

function routes(): Record<string, Responder> {
  return {
    [`GET ${BASE}`]: () => ({
      body: {
        id: ENCOUNTER,
        organizationId: "org-1",
        patientId: PATIENT,
        admissionId: "adm-1",
        visitId: null,
        encounterType: "routine_visit",
        discipline: "rn",
        serviceDate,
        status,
        lateEntryTier: "normal",
        version: 3,
        authoredByUserId: "user-1",
        isF2f: false,
        signedAt: null,
        cosignedAt: null,
      },
    }),
    [`GET ${BASE}/template`]: () => ({ body: TEMPLATE }),
    [`GET ${BASE}/selections`]: () => ({
      body: {
        templateKey: TEMPLATE.templateKey,
        vocabVersion: TEMPLATE.vocabVersion,
        sections: [],
        layer1Preview: "",
        version: 3,
        fallIncident: null,
        editedNarrative: null,
        editedNarrativeStale: false,
      },
    }),
    [`PATCH ${BASE}/selections`]: () => ({ body: { version: 4, layer1Preview: "" } }),
    [`GET /api/v1/patients/${PATIENT}`]: () => ({
      body: {
        id: PATIENT,
        firstName: "Emma",
        lastName: "Charlotte",
        mrn: "MRN-FB250B6C6A8A",
        dob: "1970-01-01",
      },
    }),
    [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: { carePlan: null } }),
    [`GET /api/v1/patients/${PATIENT}/care-plan-change-proposals`]: () => ({
      body: { patientId: PATIENT, proposals: [], redacted: false },
    }),
    [`GET ${BASE}/care-plan-links`]: () => ({ body: { links: [] } }),
    [`POST ${BASE}/finalize`]: (call) => finalizeAnswer(call),
  };
}

function mountCompose() {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(routes(), calls),
  });
  const router = createMemoryRouter(
    [
      {
        path: "/patients/:patientId/encounters/:encounterId/compose",
        element: <EncounterCompose />,
      },
      { path: "*", element: <h1>Elsewhere</h1> },
    ],
    { initialEntries: [`/patients/${PATIENT}/encounters/${ENCOUNTER}/compose`] },
  );
  const view = render(
    <ApiClientProvider client={client}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { ...view, router };
}

beforeEach(() => {
  status = "draft";
  serviceDate = daysAgo(7);
  calls = [];
  finalizeAnswer = acceptFinalize;
});
afterEach(cleanup);

const reasonBox = () => screen.findByRole("textbox", { name: /Reason for the late entry/ });
const finalizeCalls = () =>
  calls.filter((call) => call.method === "POST" && call.path === `${BASE}/finalize`);
const headerFinalize = () => screen.getByRole("button", { name: "Finalize note" });

describe("before Finalize is pressed", () => {
  it("shows the reason box with how late the note is, why a reason is needed and who approves it", async () => {
    mountCompose();

    const box = await reasonBox();
    expect(box).toBeRequired();
    const card = screen.getByRole("region", { name: "Late entry" });
    expect(within(card).getByText("This note is being entered late")).toBeInTheDocument();
    expect(card).toHaveTextContent(`The visit was on ${serviceDate}, 7 days ago.`);
    expect(card).toHaveTextContent("It counts as a significant late entry.");
    expect(card).toHaveTextContent(/identified as late, with the reason/);
    expect(card).toHaveTextContent(/Clinical Supervisor must also approve/);
    expect(card).toHaveTextContent(`0 of ${LATE_ENTRY_REASON_MIN_CHARS} characters`);
    expect(screen.queryByText("Action needed")).toBeNull();
  });

  it("does not leave the green card as the last word while the reason is outstanding", async () => {
    mountCompose();
    await reasonBox();

    expect(screen.getByText("Required documentation is complete")).toBeInTheDocument();
    expect(screen.getByText(/Add the late-entry reason above, then finalize/)).toBeInTheDocument();
    expect(screen.queryByText(/You can still review the assembled note/)).toBeNull();
  });

  it("counts the characters as they are typed and turns the green card's line back once the reason is long enough", async () => {
    const user = userEvent.setup();
    mountCompose();

    await user.type(await reasonBox(), "Too short");
    expect(screen.getByRole("region", { name: "Late entry" })).toHaveTextContent(
      `9 of ${LATE_ENTRY_REASON_MIN_CHARS} characters, 31 more needed`,
    );
    expect(screen.getByRole("button", { name: "Finalize with this reason" })).toBeDisabled();

    await user.clear(await reasonBox());
    await user.type(await reasonBox(), LONG_REASON);
    expect(screen.getByRole("button", { name: "Finalize with this reason" })).toBeEnabled();
    expect(screen.getByText(/You can still review the assembled note/)).toBeInTheDocument();
  });

  it("shows no box for a note documented the same day", async () => {
    serviceDate = daysAgo(0);
    mountCompose();

    await screen.findByText("Required documentation is complete");
    expect(screen.queryByRole("region", { name: "Late entry" })).toBeNull();
    expect(screen.getByText(/You can still review the assembled note/)).toBeInTheDocument();
  });
});

describe("finalizing with the reason", () => {
  it("sends the reason (trimmed) in the finalize body from the box's own button, then shows the success path", async () => {
    const user = userEvent.setup();
    mountCompose();

    await user.type(await reasonBox(), `  ${LONG_REASON}  `);
    await user.click(screen.getByRole("button", { name: "Finalize with this reason" }));

    expect(await screen.findByText("Note finalized")).toBeInTheDocument();
    expect(finalizeCalls()).toHaveLength(1);
    expect(finalizeCalls()[0]?.body).toEqual({ lateEntryReason: LONG_REASON });
    expect(
      screen.getByText(/Clinical Supervisor must also approve this late entry/),
    ).toBeInTheDocument();
  });

  it("sends the same reason from the header's Finalize note button", async () => {
    const user = userEvent.setup();
    mountCompose();

    await user.type(await reasonBox(), LONG_REASON);
    await user.click(headerFinalize());

    await screen.findByText("Note finalized");
    expect(finalizeCalls()[0]?.body).toEqual({ lateEntryReason: LONG_REASON });
  });

  it("does not send a reason that is too short (the server answers it in the box instead)", async () => {
    const user = userEvent.setup();
    finalizeAnswer = refuseLateEntry;
    mountCompose();

    await user.type(await reasonBox(), "Too short");
    await user.click(headerFinalize());

    await waitFor(() => expect(finalizeCalls()).toHaveLength(1));
    expect(finalizeCalls()[0]?.body).toEqual({});
  });
});

describe("when the server refuses a missing or short reason (422 LATE_ENTRY_REASON_REQUIRED)", () => {
  it("answers in the reason box in plain words, not with the server's sentence under 'Action needed'", async () => {
    const user = userEvent.setup();
    finalizeAnswer = refuseLateEntry;
    mountCompose();
    await reasonBox();

    await user.click(headerFinalize());

    expect(
      await screen.findByText(
        `A reason of at least ${LATE_ENTRY_REASON_MIN_CHARS} characters is needed before this note can be finalized.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Action needed")).toBeNull();
    expect(screen.queryByText(new RegExp(SERVER_SENTENCE))).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: /Reason for the late entry/ }),
      ),
    );
  });

  it("brings the box up even when the device's own day said the note was on time", async () => {
    const user = userEvent.setup();
    serviceDate = daysAgo(0);
    finalizeAnswer = refuseLateEntry;
    mountCompose();
    await screen.findByText("Required documentation is complete");
    expect(screen.queryByRole("region", { name: "Late entry" })).toBeNull();

    await user.click(headerFinalize());

    const card = await screen.findByRole("region", { name: "Late entry" });
    expect(card).toHaveTextContent("This note is being entered late");
    // The composer does not claim a tier or a day count it cannot know.
    expect(card).not.toHaveTextContent(/days? ago/);
    expect(card).not.toHaveTextContent(/It counts as/);
    expect(screen.queryByText("Action needed")).toBeNull();
  });

  it("keeps what was typed while the author keeps editing, and finalizes once it is long enough", async () => {
    const user = userEvent.setup();
    finalizeAnswer = refuseLateEntry;
    mountCompose();
    await user.type(await reasonBox(), "Not enough yet");
    await user.click(headerFinalize());
    await screen.findByText(/is needed before this note can be finalized/);

    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(screen.getByRole("textbox", { name: /Reason for the late entry/ })).toHaveValue(
      "Not enough yet",
    );

    finalizeAnswer = acceptFinalize;
    await user.type(
      screen.getByRole("textbox", { name: /Reason for the late entry/ }),
      `. ${LONG_REASON}`,
    );
    await user.click(screen.getByRole("button", { name: "Finalize with this reason" }));

    await screen.findByText("Note finalized");
    expect(finalizeCalls().at(-1)?.body).toEqual({
      lateEntryReason: `Not enough yet. ${LONG_REASON}`,
    });
  });

  it("still words every other refusal in the 'Action needed' box", async () => {
    const user = userEvent.setup();
    finalizeAnswer = () => ({
      status: 422,
      body: { error: { code: "COMPLIANCE_GATE_FAILED", message: "gate failed" } },
    });
    serviceDate = daysAgo(0);
    mountCompose();
    await screen.findByText("Required documentation is complete");

    await user.click(headerFinalize());

    expect(await screen.findByText("Action needed")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Late entry" })).toBeNull();
  });
});

describe("leaving the page with a reason typed that no save has sent", () => {
  const unloadIsWarned = (): boolean => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("asks before leaving, and warns on unload, once something is typed in the reason box", async () => {
    const user = userEvent.setup();
    const { router } = mountCompose();
    await screen.findByText("Required documentation is complete");
    expect(unloadIsWarned()).toBe(false);

    await user.type(await reasonBox(), "Family needed me");
    expect(unloadIsWarned()).toBe(true);
    // Save draft does not send the reason, so the save line must not say everything is saved.
    expect(screen.getByText("Late-entry reason not sent yet")).toBeInTheDocument();
    expect(screen.queryByText("All changes saved")).toBeNull();

    await act(async () => {
      await router.navigate("/patients");
    });
    const leave = await screen.findByRole("alertdialog", { name: "Leave without saving?" });
    expect(leave).toBeVisible();
    // Only the reason would be lost (the note is saved), and the dialog says so.
    expect(
      within(leave).getByText(
        "Your late-entry reason has not been sent. Keep editing or discard it before leaving.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Compose visit note" })).toBeInTheDocument();
  });

  it("does not ask when the reason box is empty", async () => {
    const { router } = mountCompose();
    await reasonBox();
    expect(unloadIsWarned()).toBe(false);

    await act(async () => {
      await router.navigate("/patients");
    });

    expect(await screen.findByRole("heading", { name: "Elsewhere" })).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("stops warning once the note is finalized with the reason", async () => {
    const user = userEvent.setup();
    mountCompose();
    await user.type(await reasonBox(), LONG_REASON);
    expect(unloadIsWarned()).toBe(true);

    await user.click(screen.getByRole("button", { name: "Finalize with this reason" }));
    await screen.findByText("Note finalized");

    await waitFor(() => expect(unloadIsWarned()).toBe(false));
  });
});

describe("the patient banner", () => {
  it("prints the MRN once: one label, then the identifier", async () => {
    mountCompose();
    await reasonBox();

    const banner = document.querySelector(".wx-patient-banner") as HTMLElement;
    expect(banner).toHaveTextContent("Emma Charlotte");
    expect(banner.textContent).toMatch(/MRN\s*FB250B6C6A8A/);
    expect(banner.textContent).not.toMatch(/MRN\s*MRN/);
    expect((banner.textContent ?? "").match(/MRN/g)).toHaveLength(1);
  });
});
