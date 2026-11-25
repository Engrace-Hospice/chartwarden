// @vitest-environment jsdom
// "Plan and Next Visit" in the note composer: the section says what a plan entry covers and where each item comes from, shows the
// patient's upcoming visits against what the plan of care orders for the author's discipline, flags (advisory only) when nothing is
// scheduled or the schedule is short, links to Scheduling's New Visit form for the patient (the link carries nothing but the patient id), and
// writes the entry's structured fields into the section's free text without touching the words already there; words typed into those
// fields and not added hold Finalize and the leave prompt. Synthetic data only.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { type Call, type Responder, makeFetch } from "./__tests__/closure-test-harness";
import { EncounterCompose } from "./encounter-compose";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ENCOUNTER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const THIS_VISIT = "cccccccc-3333-4333-8333-cccccccccc01";
const BASE = `/api/v1/encounters/${ENCOUNTER}`;
const DAY = 24 * 60 * 60 * 1000;

const SESSION = (permissions: string[]) => ({
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn_case_manager"],
  permissions,
  isAdmin: false,
});

const plain = (sectionId: string, heading: string, required: boolean) => ({
  sectionId,
  heading,
  required,
  allowedCategories: [],
  entries: [],
  recordedPanel: null,
});
const PAIN_LIMITING = "nv.sym.pain_uncontrolled";
const TEMPLATE = {
  encounterId: ENCOUNTER,
  templateKey: "routine_visit:rn",
  vocabVersion: "2026.1.0",
  encounterType: "routine_visit",
  discipline: "rn",
  sections: [
    plain("assessment", "Assessment", true),
    {
      ...plain("symptom_management", "Symptom Management", false),
      allowedCategories: ["symptom_impact"],
      entries: [
        {
          code: PAIN_LIMITING,
          label: "Symptom impact: pain limiting function",
          category: "symptom_impact",
          bodySystem: null,
          slots: ["pain_score"],
          slotSpecs: {
            pain_score: { kind: "integer", min: 0, max: 10, label: "Pain score (0-10)" },
          },
          exclusiveGroup: null,
        },
      ],
    },
    plain("plan", "Plan and Next Visit", true),
  ],
};

const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();
const visitRow = (id: string, days: number, purpose = "routine_visit", status = "published") => ({
  id,
  organizationId: "org-1",
  patientId: PATIENT,
  admissionId: "adm-1",
  assignedMembershipId: "membership-2",
  visitPurpose: purpose,
  visitSetting: "patient_home",
  scheduledStartedAt: inDays(days),
  scheduledEndedAt: inDays(days + 0.04),
  serviceDate: inDays(days).slice(0, 10),
  status,
  patientAddressId: null,
  externalFacilityId: null,
  rescheduledIntoVisitId: null,
  cancellationReasonCode: null,
});
const rnOrder = (frequencyValue: string, frequencyText: string) => ({
  id: "int-1",
  organizationId: "org-1",
  planId: "plan-1",
  problemId: "prob-1",
  goalRefs: [],
  scopeText: "Skilled nursing visit",
  frequencyText,
  frequencyValue,
  discipline: "rn",
  responsibleRole: null,
  linkedOrderId: null,
  status: "active",
  discontinueReason: null,
  version: 1,
});

let calls: Call[];
let discipline = "rn";
let visits: unknown[] | { status: number };
/** When set, answers the schedule read instead of `visits` (to hold one answer back). */
let visitsResponder: Responder | null = null;
let carePlan: unknown;
let proposals: unknown[];
let storedSections: unknown[];

function routes(): Record<string, Responder> {
  return {
    [`GET ${BASE}`]: () => ({
      body: {
        id: ENCOUNTER,
        organizationId: "org-1",
        patientId: PATIENT,
        admissionId: "adm-1",
        visitId: THIS_VISIT,
        encounterType: "routine_visit",
        discipline,
        serviceDate: "2026-11-24",
        status: "draft",
        lateEntryTier: "on_time",
        version: 3,
        authoredByUserId: "user-1",
        isF2f: false,
        signedAt: null,
        cosignedAt: null,
      },
    }),
    [`GET ${BASE}/template`]: () => ({ body: { ...TEMPLATE, discipline } }),
    [`GET ${BASE}/selections`]: () => ({
      body: {
        templateKey: TEMPLATE.templateKey,
        vocabVersion: TEMPLATE.vocabVersion,
        sections: storedSections,
        layer1Preview: "",
        version: 3,
        fallIncident: null,
        editedNarrative: null,
        editedNarrativeStale: false,
      },
    }),
    [`GET /api/v1/patients/${PATIENT}`]: () => ({
      body: { id: PATIENT, firstName: "Ada", lastName: "Lovelace", mrn: "MRN-9" },
    }),
    [`GET /api/v1/patients/${PATIENT}/care-plan`]: () => ({ body: carePlan }),
    [`GET /api/v1/patients/${PATIENT}/care-plan-change-proposals`]: () => ({
      body: { patientId: PATIENT, proposals, redacted: false },
    }),
    [`GET ${BASE}/care-plan-links`]: () => ({ body: { links: [] } }),
    "GET /api/v1/visits": (call) =>
      visitsResponder
        ? visitsResponder(call)
        : Array.isArray(visits)
          ? { body: visits }
          : { status: visits.status, body: { error: { code: "FORBIDDEN" } } },
  };
}

const planWith = (interventions: unknown[]) => ({
  id: "plan-1",
  patientId: PATIENT,
  admissionId: "adm-1",
  status: "active",
  activeVersionId: "ver-1",
  version: 1,
  versions: [],
  problems: [],
  goals: [],
  interventions,
  redacted: false,
});

function mountCompose(permissions: string[] = ["visit.read", "visit.create"]) {
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
      <SessionProvider session={SESSION(permissions)}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return Object.assign(view, { router });
}

beforeEach(() => {
  calls = [];
  discipline = "rn";
  visitsResponder = null;
  visits = [];
  carePlan = { carePlan: null };
  proposals = [];
  storedSections = [];
});
afterEach(cleanup);

const openPlan = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByRole("heading", { name: "Compose visit note" });
  await user.click(await screen.findByRole("button", { name: /^Plan and Next Visit/ }));
};
const schedule = () => screen.findByRole("region", { name: "Next visit and schedule" });
// Other sections have their own "Save" and "Clear" buttons: the entry form's are found inside its own group.
const entryButton = (name: string) =>
  within(screen.getByRole("group", { name: "Write the entry (optional)" })).getByRole("button", {
    name,
  });
const visitReads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/v1/visits");

describe("Plan and Next Visit section", () => {
  it("explains what a plan entry covers, with where each item comes from, instead of the empty-menu box", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);

    const guide = await screen.findByRole("list", { name: "What a plan entry covers" });
    expect(within(guide).getByText(/who will come, when/i)).toBeTruthy();
    expect(within(guide).getByText(/42 CFR 418\.56\(c\)\(4\) and \(5\)/)).toBeTruthy();
    expect(within(guide).getAllByText(/Medicare rule:/).length).toBeGreaterThan(0);
    expect(within(guide).getByText(/Common practice:/)).toBeTruthy();
    expect(within(guide).getAllByText(/CMS guidance:/).length).toBeGreaterThan(0);
    expect(screen.queryByText("No preset statements for this section")).toBeNull();
    expect(screen.getByText(/Nothing here is required/)).toBeTruthy();
  });

  it("reads the schedule and the plan only once the section is opened", async () => {
    const user = userEvent.setup();
    mountCompose();
    await screen.findByRole("heading", { name: "Compose visit note" });
    expect(visitReads()).toHaveLength(0);

    await user.click(await screen.findByRole("button", { name: /^Plan and Next Visit/ }));
    await schedule();
    await waitFor(() => expect(visitReads()).toHaveLength(1));
    expect(visitReads()[0]?.query.get("patient")).toBe(PATIENT);
  });

  it("flags that nothing is scheduled, and links to the scheduler for this patient", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);

    const region = await schedule();
    expect(
      await within(region).findByText(/No RN visit is scheduled in the next 30 days/),
    ).toBeTruthy();
    const link = within(region).getByRole("link", { name: "Schedule next visit" });
    const href = new URL(link.getAttribute("href") as string, "http://localhost");
    expect(href.pathname).toBe("/calendar");
    expect(href.searchParams.get("patient")).toBe(PATIENT);
    expect(href.searchParams.get("newVisit")).toBe("1");
    // The patient id and nothing else: no visit purpose or day is put in the URL.
    expect([...href.searchParams.keys()]).toEqual(["patient", "newVisit"]);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    // The new tab is said in the hint beside the link, and the link is described by it.
    expect(link).toHaveAccessibleDescription(
      "Opens Scheduling in a new tab for this patient; your note stays as it is.",
    );
  });

  it("does not read an empty answer as a definitive empty schedule: the server only lists the visits the viewer may see", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);

    const region = await schedule();
    expect(
      await within(region).findByText(
        "No visits that you can see are scheduled in the next 30 days.",
      ),
    ).toBeTruthy();
    expect(within(region).queryByText("No visits are scheduled in the next 30 days.")).toBeNull();
  });

  it.each(["pt", "ot", "slp"])(
    "makes no schedule claim for a %s note, since no visit purpose is scheduled for that discipline",
    async (therapy) => {
      const user = userEvent.setup();
      discipline = therapy;
      visits = [visitRow("v-nursing", 3)];
      mountCompose();
      await openPlan(user);

      const region = await schedule();
      expect(
        await within(region).findByRole("list", { name: "Upcoming scheduled visits" }),
      ).toBeTruthy();
      expect(within(region).queryByText(/visit is scheduled in the next/)).toBeNull();
      expect(
        within(region).queryByText(
          /visits? scheduled in the next \d+ days; the plan of care orders/,
        ),
      ).toBeNull();
      expect(
        within(region).queryByText(/The schedule includes the ordered number of visits/),
      ).toBeNull();
    },
  );

  describe("when the clinician comes back from booking in the other tab", () => {
    const comeBack = (): void => {
      window.dispatchEvent(new Event("focus"));
    };
    const becomeVisible = (state: "visible" | "hidden"): void => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    // Only the clock is frozen: reads are spaced by it, so a test moves it on by hand.
    const later = (ms: number): void => {
      vi.setSystemTime(new Date(Date.now() + ms));
    };
    // Reads are spaced 30 s apart: a return after this is read, a return before it (WITHIN_THE_GAP_MS) is not.
    const AFTER_THE_LAST_READ_MS = 31_000;
    const WITHIN_THE_GAP_MS = 29_000;
    // A read is sent a moment after the event that asks for it: wait that moment before asserting that none was.
    const settle = (): Promise<void> =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      becomeVisible("visible");
      vi.useRealTimers();
    });
    const bookedButton = () =>
      screen.findByRole("button", { name: "Use the next scheduled visit" });

    it("reads the schedule again on window focus, so the new visit replaces the warning and can be used", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      const region = await schedule();
      expect(
        await within(region).findByText(/No RN visit is scheduled in the next 30 days/),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Use the next scheduled visit" })).toBeNull();

      visits = [visitRow("v-booked", 3)];
      later(AFTER_THE_LAST_READ_MS);
      act(comeBack);

      expect(await bookedButton()).toBeTruthy();
      expect(within(region).queryByText(/No RN visit is scheduled/)).toBeNull();
      expect(visitReads()).toHaveLength(2);
    });

    it("reads it again when the tab becomes visible, and not when it is hidden", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await waitFor(() => expect(visitReads()).toHaveLength(1));

      visits = [visitRow("v-booked", 3)];
      later(AFTER_THE_LAST_READ_MS);
      act(() => becomeVisible("hidden"));
      await settle();
      expect(visitReads()).toHaveLength(1);
      act(() => becomeVisible("visible"));

      expect(await bookedButton()).toBeTruthy();
      expect(visitReads()).toHaveLength(2);
    });

    it("reads once, not twice, when focus and visibility both fire as the tab comes back", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await waitFor(() => expect(visitReads()).toHaveLength(1));

      // Straight after a read, and for the rest of the gap, nothing is read again.
      act(comeBack);
      await settle();
      expect(visitReads()).toHaveLength(1);
      later(WITHIN_THE_GAP_MS);
      act(() => {
        comeBack();
        becomeVisible("visible");
      });
      await settle();
      expect(visitReads()).toHaveLength(1);

      later(AFTER_THE_LAST_READ_MS - WITHIN_THE_GAP_MS);
      act(() => {
        comeBack();
        becomeVisible("visible");
      });
      await waitFor(() => expect(visitReads()).toHaveLength(2));
      await settle();
      expect(visitReads()).toHaveLength(2);
    });

    it("does not read while the Plan section is not the open one, and reads when it is opened again", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await waitFor(() => expect(visitReads()).toHaveLength(1));

      await user.click(screen.getByRole("button", { name: /^Assessment/ }));
      later(AFTER_THE_LAST_READ_MS);
      act(comeBack);
      await settle();
      expect(visitReads()).toHaveLength(1);

      visits = [visitRow("v-booked", 3)];
      await user.click(screen.getByRole("button", { name: /^Plan and Next Visit/ }));
      expect(await bookedButton()).toBeTruthy();
      expect(visitReads()).toHaveLength(2);
    });

    it("keeps the schedule it has when a later read fails, but not when it is refused", async () => {
      const user = userEvent.setup();
      visits = [visitRow("v-booked", 3)];
      mountCompose();
      await openPlan(user);
      const region = await schedule();
      expect(await bookedButton()).toBeTruthy();

      visits = { status: 500 };
      later(AFTER_THE_LAST_READ_MS);
      act(comeBack);
      await waitFor(() => expect(visitReads()).toHaveLength(2));
      await act(async () => undefined);

      expect(within(region).getByRole("list", { name: "Upcoming scheduled visits" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Use the next scheduled visit" })).toBeTruthy();
      expect(within(region).queryByText(/schedule could not be read/)).toBeNull();

      // A refusal is an answer about access, not a hiccup: the list is not kept.
      visits = { status: 403 };
      later(AFTER_THE_LAST_READ_MS);
      act(comeBack);
      expect(
        await within(region).findByText(/do not have access to this patient's schedule/),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Use the next scheduled visit" })).toBeNull();
    });

    it("keeps the newest answer when an older read answers late", async () => {
      const user = userEvent.setup();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reads = 0;
      visitsResponder = async () => {
        reads += 1;
        if (reads === 1) {
          await held;
          return { body: [] };
        }
        return { body: [visitRow("v-booked", 3)] };
      };
      mountCompose();
      await openPlan(user);
      await schedule();
      await waitFor(() => expect(reads).toBe(1));

      later(AFTER_THE_LAST_READ_MS);
      act(comeBack);
      expect(await bookedButton()).toBeTruthy();
      // The first read answers now, with the schedule as it was before the booking: it must not put the warning back.
      await act(async () => release());
      await waitFor(() => expect(visitReads()).toHaveLength(2));
      expect(screen.getByRole("button", { name: "Use the next scheduled visit" })).toBeTruthy();
    });

    it("stops listening once the note is left", async () => {
      const user = userEvent.setup();
      const view = mountCompose();
      await openPlan(user);
      await schedule();
      await waitFor(() => expect(visitReads()).toHaveLength(1));

      view.unmount();
      later(AFTER_THE_LAST_READ_MS);
      act(comeBack);
      await settle();

      expect(visitReads()).toHaveLength(1);
    });

    it("works the schedule out from the time of the read, not from when the section was first opened", async () => {
      const user = userEvent.setup();
      vi.setSystemTime(new Date(2026, 11, 1, 12, 0));
      visits = [visitRow("v-soon", 2)];
      mountCompose();
      await openPlan(user);
      const region = await schedule();
      expect(
        await within(region).findByRole("list", { name: "Upcoming scheduled visits" }),
      ).toBeTruthy();

      // Three days on, the note still open: the same visit is now in the past, so the next read no longer lists it as upcoming.
      vi.setSystemTime(new Date(2026, 11, 4, 12, 0));
      act(comeBack);

      expect(
        await within(region).findByText(
          "No visits that you can see are scheduled in the next 30 days.",
        ),
      ).toBeTruthy();
      expect(within(region).queryByRole("list", { name: "Upcoming scheduled visits" })).toBeNull();
    });
  });

  it("flags a schedule short of the ordered frequency, and still links with the patient id only", async () => {
    const user = userEvent.setup();
    carePlan = planWith([rnOrder("2:visit:week", "2 visits/week")]);
    visits = [
      visitRow("v1", 3),
      visitRow("v-other", 2, "msw_followup"),
      visitRow("v-cancelled", 4, "routine_visit", "cancelled"),
      visitRow(THIS_VISIT, 1),
    ];
    mountCompose();
    await openPlan(user);

    const region = await schedule();
    expect(
      await within(region).findByText(/Plan of care orders for RN: 2 visits\/week/),
    ).toBeTruthy();
    expect(
      within(region).getByText(
        "1 visit scheduled in the next 7 days; the plan of care orders 2 visits/week.",
      ),
    ).toBeTruthy();
    // The note's own visit is not an upcoming one: three visits are listed, not four.
    expect(
      within(region).getByRole("list", { name: "Upcoming scheduled visits" }).children,
    ).toHaveLength(2);
    expect(
      within(region).getByRole("link", { name: "Schedule next visit" }).getAttribute("href"),
    ).toBe(`/calendar?patient=${PATIENT}&newVisit=1`);
  });

  it("says the schedule includes the ordered visits when it does", async () => {
    const user = userEvent.setup();
    carePlan = planWith([rnOrder("2:visit:week", "2 visits/week")]);
    visits = [visitRow("v1", 2), visitRow("v2", 5)];
    mountCompose();
    await openPlan(user);

    expect(
      await screen.findByText("The schedule includes the ordered number of visits."),
    ).toBeTruthy();
    expect(screen.queryByText(/No RN visit is scheduled/)).toBeNull();
  });

  it("does not claim an empty schedule when the schedule cannot be read", async () => {
    const user = userEvent.setup();
    visits = { status: 403 };
    mountCompose(["visit.create"]);
    await openPlan(user);

    expect(await screen.findByText(/do not have access to this patient's schedule/)).toBeTruthy();
    expect(screen.queryByText(/No RN visit is scheduled/)).toBeNull();
    expect(screen.queryByText(/No visits that you can see are scheduled/)).toBeNull();
  });

  it("offers the schedule, not a booking, to someone who may read but not create visits", async () => {
    const user = userEvent.setup();
    mountCompose(["visit.read"]);
    await openPlan(user);

    const region = await schedule();
    expect(within(region).queryByRole("link", { name: "Schedule next visit" })).toBeNull();
    const link = await within(region).findByRole("link", { name: "Open this patient's schedule" });
    expect(link.getAttribute("href")).toBe(`/calendar?patient=${PATIENT}`);
  });

  it("surfaces the plan-of-care changes this visit proposed", async () => {
    const user = userEvent.setup();
    carePlan = planWith([]);
    proposals = [
      {
        id: "p-1",
        status: "draft",
        kind: "goal_add",
        carePlanId: "plan-1",
        patientId: PATIENT,
        sourceEncounterId: ENCOUNTER,
        change: { originalText: "Keep the patient comfortable at home" },
      },
    ];
    mountCompose();
    await openPlan(user);

    expect(
      await screen.findByText(/1 plan-of-care change is proposed from this visit/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to the plan of care step" })).toBeTruthy();
  });

  it("writes the filled fields into the free text, keeping the words already there, and only once", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);
    await schedule();

    const freeText = (await screen.findByLabelText("Additional notes")) as HTMLTextAreaElement;
    await user.type(freeText, "Continue current plan.");
    await user.type(screen.getByLabelText("Next visit date"), "2026-12-05");
    await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");
    await user.click(entryButton("Save"));

    expect(freeText.value).toBe(
      "Continue current plan.\nNext visit: Dec 5, 2026.\nCall the hospice if: New fever or a fall",
    );
    expect(entryButton("Save")).toHaveProperty("disabled", true);
  });

  it("hands focus to the first field when saving clears the fields and disables the button that was pressed", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);
    await schedule();

    await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");
    await user.click(entryButton("Save"));

    expect(entryButton("Save")).toBeDisabled();
    expect(screen.getByLabelText("Next visit by")).toHaveFocus();
    expect(
      screen.getByText("Added to the free text below. Save the note to refresh the preview."),
    ).toBeTruthy();
  });

  it("offers Save, Discard entries and Clear, all disabled while nothing is typed", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);
    await schedule();

    expect(entryButton("Save")).toBeDisabled();
    expect(entryButton("Discard entries")).toBeDisabled();
    expect(entryButton("Clear")).toBeDisabled();

    await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");

    expect(entryButton("Save")).toBeEnabled();
    expect(entryButton("Discard entries")).toBeEnabled();
    expect(entryButton("Clear")).toBeEnabled();
  });

  it("empties every field, the by and date choice included, when the entries are discarded, adding nothing to the note", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);
    await schedule();
    const freeText = (await screen.findByLabelText("Additional notes")) as HTMLTextAreaElement;
    await user.selectOptions(screen.getByLabelText("Next visit by"), "rn");
    await user.type(screen.getByLabelText("Next visit date"), "2026-12-05");
    await user.type(screen.getByLabelText("Focus of next visit"), "Wound check");
    await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");

    await user.click(entryButton("Discard entries"));

    expect((screen.getByLabelText("Next visit by") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Next visit date") as HTMLInputElement).value).toBe("");
    for (const label of [
      "Focus of next visit",
      "Follow-ups from this visit",
      "Orders and supplies pending",
      "Teaching and instructions given",
      "Call the hospice if",
    ]) {
      expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe("");
    }
    expect(freeText.value).toBe("");
    expect(screen.getByLabelText("Next visit by")).toHaveFocus();
    expect(entryButton("Discard entries")).toBeDisabled();
  });

  it("hides the confirmation when the entries are discarded after a Save", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);
    await schedule();
    await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");
    await user.click(entryButton("Save"));
    const confirmation = "Added to the free text below. Save the note to refresh the preview.";
    expect(screen.getByText(confirmation)).toBeTruthy();
    await user.type(
      screen.getByLabelText("Teaching and instructions given"),
      "Turning every 2 hours",
    );

    await user.click(entryButton("Discard entries"));

    expect(screen.queryByText(confirmation)).toBeNull();
  });

  it("empties only the five free-text boxes on Clear, keeping the by and date choice, and hands focus to the first box", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);
    await schedule();
    await user.selectOptions(screen.getByLabelText("Next visit by"), "rn");
    await user.type(screen.getByLabelText("Next visit date"), "2026-12-05");
    await user.type(screen.getByLabelText("Focus of next visit"), "Wound check");
    await user.type(screen.getByLabelText("Follow-ups from this visit"), "Call the pharmacy");
    await user.type(screen.getByLabelText("Orders and supplies pending"), "Dressings");
    await user.type(screen.getByLabelText("Teaching and instructions given"), "Turning");
    await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");

    await user.click(entryButton("Clear"));

    for (const label of [
      "Focus of next visit",
      "Follow-ups from this visit",
      "Orders and supplies pending",
      "Teaching and instructions given",
      "Call the hospice if",
    ]) {
      expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe("");
    }
    expect((screen.getByLabelText("Next visit by") as HTMLSelectElement).value).toBe("rn");
    expect((screen.getByLabelText("Next visit date") as HTMLInputElement).value).toBe("2026-12-05");
    expect(screen.getByLabelText("Focus of next visit")).toHaveFocus();
    expect(entryButton("Clear")).toBeDisabled();
    expect(entryButton("Save")).toBeEnabled();
  });

  describe("words typed into the entry fields and not added to the note", () => {
    const finalizeNote = () => screen.getByRole("button", { name: "Finalize note" });
    const unsavedNotice =
      "Save or discard the unsaved entries in Plan and Next Visit before finalizing.";
    const selectionWrites = () =>
      calls.filter((c) => c.method === "PATCH" && c.path === `${BASE}/selections`);

    it("hold Finalize, name the section, bring it into view, and guard the browser and the router", async () => {
      const user = userEvent.setup();
      const { router } = mountCompose();
      await openPlan(user);
      await schedule();
      await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");
      await user.click(screen.getByRole("button", { name: /^Assessment/ }));
      expect(screen.getByLabelText("Call the hospice if")).not.toBeVisible();

      expect(window.dispatchEvent(new Event("beforeunload", { cancelable: true }))).toBe(false);
      await user.click(finalizeNote());

      expect(await screen.findByText("Unsaved entries in a section")).toBeTruthy();
      expect(screen.getByText(unsavedNotice)).toBeTruthy();
      expect(screen.getByLabelText("Call the hospice if")).toBeVisible();
      expect(selectionWrites()).toHaveLength(0);

      await act(async () => {
        await router.navigate("/elsewhere");
      });
      expect(screen.getByRole("alertdialog", { name: "Leave without saving?" })).toBeTruthy();
    });

    it("let Finalize go ahead once they are saved with the form's Save button, and take the notice away", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");
      await user.click(finalizeNote());
      expect(await screen.findByText(unsavedNotice)).toBeTruthy();
      expect(screen.getByText(/Use that section's own Save button/)).toBeTruthy();

      await user.click(entryButton("Save"));
      expect(screen.queryByText(unsavedNotice)).toBeNull();
      await user.click(finalizeNote());

      await waitFor(() => expect(selectionWrites()).toHaveLength(1));
      expect(screen.queryByText(unsavedNotice)).toBeNull();
    });

    it("let Finalize go ahead once they are discarded with Discard entries", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await user.selectOptions(screen.getByLabelText("Next visit by"), "rn");
      await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");
      await user.click(finalizeNote());
      expect(await screen.findByText(unsavedNotice)).toBeTruthy();

      await user.click(entryButton("Discard entries"));
      expect(screen.queryByText(unsavedNotice)).toBeNull();
      await user.click(finalizeNote());

      await waitFor(() => expect(selectionWrites()).toHaveLength(1));
      expect(screen.queryByText(unsavedNotice)).toBeNull();
      expect((screen.getByLabelText("Additional notes") as HTMLTextAreaElement).value).toBe("");
    });

    it("keep holding Finalize after Clear while the by or date choice is still filled, and release it once that goes too", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await user.type(screen.getByLabelText("Next visit date"), "2026-12-05");
      await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");

      await user.click(entryButton("Clear"));
      await user.click(finalizeNote());

      expect(await screen.findByText(unsavedNotice)).toBeTruthy();
      expect(selectionWrites()).toHaveLength(0);

      await user.click(entryButton("Discard entries"));
      expect(screen.queryByText(unsavedNotice)).toBeNull();
      await user.click(finalizeNote());

      await waitFor(() => expect(selectionWrites()).toHaveLength(1));
    });

    it("stop holding Finalize after Clear when only the free-text boxes were typed", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await user.type(screen.getByLabelText("Call the hospice if"), "New fever or a fall");
      await user.click(finalizeNote());
      expect(await screen.findByText(unsavedNotice)).toBeTruthy();

      await user.click(entryButton("Clear"));
      expect(screen.queryByText(unsavedNotice)).toBeNull();
      await user.click(finalizeNote());

      await waitFor(() => expect(selectionWrites()).toHaveLength(1));
    });

    it("do not hold Finalize when the fields are empty or only blank", async () => {
      const user = userEvent.setup();
      mountCompose();
      await openPlan(user);
      await schedule();
      await user.type(screen.getByLabelText("Call the hospice if"), "   ");
      await user.click(finalizeNote());

      await waitFor(() => expect(selectionWrites()).toHaveLength(1));
      expect(screen.queryByText(unsavedNotice)).toBeNull();
    });
  });

  it("fills the next visit's day and discipline from the scheduled visit when asked", async () => {
    const user = userEvent.setup();
    visits = [visitRow("v1", 3)];
    mountCompose();
    await openPlan(user);

    await user.click(await screen.findByRole("button", { name: "Use the next scheduled visit" }));

    expect((screen.getByLabelText("Next visit by") as HTMLSelectElement).value).toBe("rn");
    expect((screen.getByLabelText("Next visit date") as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("shows the pain helper's plan-of-care review prompt where the plan is written, and only when the note raises one", async () => {
    const user = userEvent.setup();
    storedSections = [
      {
        sectionId: "symptom_management",
        entries: [{ code: PAIN_LIMITING, params: { pain_score: "7" } }],
        freeText: "",
      },
    ];
    mountCompose();
    await openPlan(user);

    expect(await screen.findByText("Consider a plan-of-care review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go to Plan of care" })).toBeTruthy();
  });

  it("shows no review prompt when the note records no pain", async () => {
    const user = userEvent.setup();
    mountCompose();
    await openPlan(user);
    await schedule();

    expect(screen.queryByText("Consider a plan-of-care review")).toBeNull();
  });
});
