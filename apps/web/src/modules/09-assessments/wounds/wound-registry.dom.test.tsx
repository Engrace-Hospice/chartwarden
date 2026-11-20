// @vitest-environment jsdom
// The patient's wounds: a register of wounds beside a right-hand drawer for the selected one. A wound is registered once
// and observed at every visit; an observation is corrected by superseding it, never edited. These tests drive the screen
// the way a clinician does and assert on the REQUESTS the real api client sends (path, query, If-Match, exact body),
// because the form's whole job is to send the right thing and to keep the wrong thing from being sent.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { WoundRegistry } from "./wound-registry";
import {
  type Call,
  EARLIER_OBSERVATION_ID,
  OBSERVATION_ID,
  PATIENT_ID,
  type Responder,
  SECOND_WOUND_ID,
  WOUND_ID,
  listItem,
  mount,
  observation,
  woundRoutes,
  woundView,
  writesOf,
} from "./wound-test-fixture";

const WOUNDS = `/api/v1/patients/${PATIENT_ID}/wounds`;
const WOUND = `${WOUNDS}/${WOUND_ID}`;
const OBSERVATIONS = `${WOUND}/observations`;
const CORRECTIONS = `${OBSERVATIONS}/${OBSERVATION_ID}/corrections`;

const earlier = observation({
  id: EARLIER_OBSERVATION_ID,
  observedAt: "2026-11-12T12:00:00.000Z",
  lengthCm: 4,
  widthCm: 2,
  areaCm2: 8,
  areaChangePercent: null,
  areaChangeSinceObservedAt: null,
  trend: "new",
  version: 1,
});

function show(overrides: Record<string, Responder> = {}) {
  const calls: Call[] = [];
  const wounds = [listItem()];
  mount({
    calls,
    routePath: "/patients/:patientId/wounds",
    element: <WoundRegistry />,
    routes: {
      ...woundRoutes({
        wounds,
        details: { [WOUND_ID]: [observation(), earlier] },
      }),
      ...overrides,
    },
  });
  return calls;
}

async function openDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("row", { name: /Left heel/ }));
  return within(await screen.findByRole("complementary", { name: "Wound: Left heel" }));
}

/** Axe over the whole page. The `region` rule asks the PAGE to put its content in landmarks, which the app shell does and a test mount has no shell for. */
async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, { rules: { region: { enabled: false } } });
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

describe("the wound register", () => {
  it("lists the open wounds with site, cause, stage, latest measurement, last observed date and trend", async () => {
    const calls = show();
    const row = await screen.findByRole("row", { name: /Left heel/ });
    expect(within(row).getByText("Pressure injury")).toBeTruthy();
    expect(within(row).getByText("Stage 3")).toBeTruthy();
    expect(within(row).getByText("3.0 × 2.0 cm (area 6 cm²)")).toBeTruthy();
    expect(within(row).getByText(/Nov 1[89], 2026/)).toBeTruthy();
    expect(within(row).getByText("Improving")).toBeTruthy();
    const read = calls.find((c) => c.method === "GET" && c.path === WOUNDS);
    expect(read?.query.get("status")).toBe("open");
  });

  it("the status filter reads the list again for that status", async () => {
    const user = userEvent.setup();
    const calls = show();
    await screen.findByRole("row", { name: /Left heel/ });
    await user.selectOptions(screen.getByLabelText("Show"), "healed");
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === WOUNDS && c.query.get("status") === "healed"),
      ).toHaveLength(1),
    );
  });

  it("a patient with no wounds reads as such and offers to register one", async () => {
    const calls: Call[] = [];
    mount({
      calls,
      routePath: "/patients/:patientId/wounds",
      element: <WoundRegistry />,
      routes: woundRoutes({ wounds: [] }),
    });
    expect(await screen.findByText("No wounds recorded")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Register wound/ }).length).toBeGreaterThan(0);
  });

  it('reads "All wounds" of a patient with none as no wounds, and still offers to register one', async () => {
    const user = userEvent.setup();
    mount({
      calls: [],
      routePath: "/patients/:patientId/wounds",
      element: <WoundRegistry />,
      routes: woundRoutes({ wounds: [] }),
    });
    await screen.findByText("No wounds recorded");
    await user.selectOptions(screen.getByLabelText("Show"), "all");
    expect(
      await screen.findByText(
        "This patient has no wound on record. Register one when a wound is found.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No wounds match")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Register wound/ }).length).toBeGreaterThan(1);
  });

  it("reads a status filter with no match as no match, with no register action beside it", async () => {
    const user = userEvent.setup();
    mount({
      calls: [],
      routePath: "/patients/:patientId/wounds",
      element: <WoundRegistry />,
      routes: woundRoutes({ wounds: [] }),
    });
    await screen.findByText("No wounds recorded");
    await user.selectOptions(screen.getByLabelText("Show"), "healed");
    expect(await screen.findByText("No wounds match")).toBeTruthy();
    // Only the page header's button remains.
    expect(screen.getAllByRole("button", { name: /Register wound/ })).toHaveLength(1);
  });

  it("a failed read is announced with a retry, never shown as an empty register", async () => {
    const calls: Call[] = [];
    mount({
      calls,
      routePath: "/patients/:patientId/wounds",
      element: <WoundRegistry />,
      routes: { [`GET ${WOUNDS}`]: () => ({ status: 500, body: { error: { code: "INTERNAL" } } }) },
    });
    expect(await screen.findByText("Wounds unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No wounds recorded")).toBeNull();
  });

  it("a refused read says the person has no access, with no retry", async () => {
    const calls: Call[] = [];
    mount({
      calls,
      routePath: "/patients/:patientId/wounds",
      element: <WoundRegistry />,
      routes: {
        [`GET ${WOUNDS}`]: () => ({ status: 403, body: { error: { code: "FORBIDDEN" } } }),
      },
    });
    expect(await screen.findByText("You do not have access")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});

describe("a selected wound's history", () => {
  it("shows the observations newest first, with the area change against the earlier visit", async () => {
    const user = userEvent.setup();
    show();
    const drawer = await openDrawer(user);
    const history = await drawer.findByRole("list", { name: "Observations, newest first" });
    const entries = within(history).getAllByRole("listitem");
    expect(entries).toHaveLength(2);
    expect(
      within(entries[0] as HTMLElement).getByText(/^−25\.0% against Nov 1[12], 2026$/),
    ).toBeTruthy();
    expect(within(entries[0] as HTMLElement).getByText("3.0 × 2.0 cm (area 6 cm²)")).toBeTruthy();
    // The first measured visit has no earlier one to compare against.
    expect(within(entries[1] as HTMLElement).queryByText(/against/)).toBeNull();
  });
});

describe("recording an observation", () => {
  async function openForm(user: ReturnType<typeof userEvent.setup>) {
    const drawer = await openDrawer(user);
    await user.click(await drawer.findByRole("button", { name: "Record observation" }));
    return screen.findByRole("form", { name: "Record observation" });
  }

  it("POSTs exactly what was entered: no date, no visit, nothing left empty", async () => {
    const user = userEvent.setup();
    const calls = show({ [`POST ${OBSERVATIONS}`]: () => ({ status: 201, body: observation() }) });
    const form = within(await openForm(user));
    await user.type(form.getByLabelText("Length (cm)"), "3.5");
    await user.type(form.getByLabelText("Width (cm)"), "2");
    await user.type(form.getByLabelText("Depth (cm)"), "0.5");
    await user.click(form.getByLabelText("Granulation"));
    await user.click(form.getByLabelText("Slough"));
    await user.selectOptions(form.getByLabelText("Pressure injury stage"), "stage_3");
    await user.selectOptions(form.getByLabelText("Trend"), "improving");
    await user.selectOptions(form.getByLabelText("Pain at the wound"), "4");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    const write = writesOf(calls)[0] as Call;
    expect(write.method).toBe("POST");
    expect(write.path).toBe(OBSERVATIONS);
    expect(write.body).toEqual({
      stage: "stage_3",
      lengthCm: 3.5,
      widthCm: 2,
      depthCm: 0.5,
      woundBed: ["granulation", "slough"],
      painScore: 4,
      trend: "improving",
    });
    // The write carries an Idempotency-Key, so a lost reply can be retried without doubling the observation.
    expect(write.headers.get("idempotency-key")).toBeTruthy();
    // The drawer goes back to the history and the list behind it is read again.
    expect(await screen.findByRole("button", { name: "Record observation" })).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && c.path === WOUNDS).length).toBeGreaterThan(
        1,
      ),
    );
  });

  it("only a pressure injury offers a stage", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    mount({
      calls,
      routePath: "/patients/:patientId/wounds",
      element: <WoundRegistry />,
      routes: woundRoutes({
        wounds: [listItem({ etiology: "venous_ulcer" }, observation({ stage: null }))],
      }),
    });
    await user.click(await screen.findByRole("row", { name: /Left heel/ }));
    const drawer = within(await screen.findByRole("complementary", { name: "Wound: Left heel" }));
    await user.click(await drawer.findByRole("button", { name: "Record observation" }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    expect(form.queryByLabelText("Pressure injury stage")).toBeNull();
  });

  it("refuses a depth without a length and a width, in words, and sends nothing", async () => {
    const user = userEvent.setup();
    const calls = show();
    const form = within(await openForm(user));
    await user.type(form.getByLabelText("Depth (cm)"), "0.5");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    expect(await form.findByText("A depth needs the length and the width.")).toBeTruthy();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("refuses a measurement out of range or with two decimals", async () => {
    const user = userEvent.setup();
    const calls = show();
    const form = within(await openForm(user));
    await user.type(form.getByLabelText("Length (cm)"), "101");
    await user.type(form.getByLabelText("Width (cm)"), "2.55");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    expect(await form.findByText("The length cannot be more than 100 cm.")).toBeTruthy();
    expect(form.getByText("The width takes one decimal place.")).toBeTruthy();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("names the dressing when one was applied", async () => {
    const user = userEvent.setup();
    const calls = show();
    const form = within(await openForm(user));
    await user.selectOptions(form.getByLabelText("Dressing changed at this visit"), "yes");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    expect(await form.findByText("Name the dressing that was applied.")).toBeTruthy();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("will not record an observation with nothing in it", async () => {
    const user = userEvent.setup();
    const calls = show();
    const form = within(await openForm(user));
    await user.click(form.getByRole("button", { name: "Record observation" }));
    expect(await form.findByText("Record at least one finding.")).toBeTruthy();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("intact skin excludes every other finding around the wound", async () => {
    const user = userEvent.setup();
    show();
    const form = within(await openForm(user));
    const intact = form.getByLabelText("Intact") as HTMLInputElement;
    const redness = form.getByLabelText("Erythema (redness)") as HTMLInputElement;
    await user.click(redness);
    await user.click(form.getByLabelText("Macerated"));
    await user.click(intact);
    expect(intact.checked).toBe(true);
    expect(redness.checked).toBe(false);
    expect((form.getByLabelText("Macerated") as HTMLInputElement).checked).toBe(false);
    await user.click(redness);
    expect(intact.checked).toBe(false);
    expect(redness.checked).toBe(true);
  });

  it("shows the server's refusal in plain words and keeps what was typed", async () => {
    const user = userEvent.setup();
    const calls = show({
      [`POST ${OBSERVATIONS}`]: () => ({
        status: 409,
        body: { error: { code: "WOUND_NOT_OPEN", message: "the wound is already resolved" } },
      }),
    });
    const form = within(await openForm(user));
    await user.selectOptions(form.getByLabelText("Trend"), "stable");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    expect(
      await form.findByText(
        "This wound is already healed or resolved, so it takes no more observations.",
      ),
    ).toBeTruthy();
    expect((form.getByLabelText("Trend") as HTMLSelectElement).value).toBe("stable");
    expect(writesOf(calls)).toHaveLength(1);
  });

  it("the drawer cannot be closed while the write is in flight", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    show({
      [`POST ${OBSERVATIONS}`]: async () => {
        await gate;
        return { status: 201, body: observation() };
      },
    });
    const form = within(await openForm(user));
    await user.selectOptions(form.getByLabelText("Trend"), "stable");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    const drawer = within(screen.getByRole("complementary", { name: "Wound: Left heel" }));
    await waitFor(() =>
      expect((drawer.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    release?.();
    await waitFor(() =>
      expect((drawer.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });
});

describe("correcting an observation", () => {
  async function openCorrection(user: ReturnType<typeof userEvent.setup>) {
    const drawer = await openDrawer(user);
    const history = await drawer.findByRole("list", { name: "Observations, newest first" });
    const newest = within(history).getAllByRole("listitem")[0] as HTMLElement;
    await user.click(within(newest).getByRole("button", { name: /^Correct the observation of / }));
    return screen.findByRole("form", { name: "Correct observation" });
  }

  it("restates the whole observation with a coded reason, pinned to its version by If-Match", async () => {
    const user = userEvent.setup();
    const calls = show({
      [`POST ${CORRECTIONS}`]: () => ({ status: 201, body: observation({ version: 1 }) }),
    });
    const form = within(await openCorrection(user));
    // It opens on the observation as recorded, so a correction changes one thing and keeps the rest.
    expect((form.getByLabelText("Length (cm)") as HTMLInputElement).value).toBe("3");
    expect((form.getByLabelText("Granulation") as HTMLInputElement).checked).toBe(true);
    await user.clear(form.getByLabelText("Length (cm)"));
    await user.type(form.getByLabelText("Length (cm)"), "3.5");
    await user.selectOptions(
      form.getByLabelText(/^Reason for the correction/),
      "measurement_error",
    );
    await user.click(form.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    const write = writesOf(calls)[0] as Call;
    expect(write.path).toBe(CORRECTIONS);
    expect(write.headers.get("if-match")).toBe("3");
    expect(write.body).toEqual({
      stage: "stage_3",
      lengthCm: 3.5,
      widthCm: 2,
      depthCm: null,
      undermining: null,
      woundBed: ["granulation"],
      exudateAmount: "moderate",
      exudateType: "serous",
      odor: "none",
      periwound: ["erythema"],
      painScore: 4,
      dressing: "foam",
      dressingChanged: true,
      infectionSigns: false,
      trend: "improving",
      correctionReason: "measurement_error",
    });
  });

  it("will not send a correction without a reason", async () => {
    const user = userEvent.setup();
    const calls = show();
    const form = within(await openCorrection(user));
    await user.click(form.getByRole("button", { name: "Save correction" }));
    expect(await form.findByText("Choose why this is corrected.")).toBeTruthy();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("says plainly when someone else changed the observation first", async () => {
    const user = userEvent.setup();
    show({
      [`POST ${CORRECTIONS}`]: () => ({
        status: 409,
        body: { error: { code: "STALE_VERSION", message: "the observation changed" } },
      }),
    });
    const form = within(await openCorrection(user));
    await user.selectOptions(form.getByLabelText(/^Reason for the correction/), "assessment_error");
    await user.click(form.getByRole("button", { name: "Save correction" }));
    expect(
      await form.findByText(
        "Someone else changed this observation after you opened it. Reload it, then correct it again.",
      ),
    ).toBeTruthy();
  });
});

describe("closing a wound", () => {
  async function openResolve(user: ReturnType<typeof userEvent.setup>) {
    const drawer = await openDrawer(user);
    await user.click(await drawer.findByRole("button", { name: "Mark healed or resolved" }));
    return screen.findByRole("form", { name: "Close this wound" });
  }

  it("POSTs the outcome, and the date only when one was chosen", async () => {
    const user = userEvent.setup();
    const calls = show({
      [`POST ${WOUND}/resolve`]: () => ({
        body: woundView({ status: "resolved_other", closedOn: "2026-11-18" }),
      }),
    });
    const form = within(await openResolve(user));
    await user.selectOptions(form.getByLabelText("Outcome"), "resolved_other");
    await user.type(form.getByLabelText("Date closed"), "2026-11-18");
    await user.click(form.getByRole("button", { name: "Close wound" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect((writesOf(calls)[0] as Call).path).toBe(`${WOUND}/resolve`);
    expect((writesOf(calls)[0] as Call).body).toEqual({
      status: "resolved_other",
      closedOn: "2026-11-18",
    });
  });

  it("defaults to healed with no date", async () => {
    const user = userEvent.setup();
    const calls = show({
      [`POST ${WOUND}/resolve`]: () => ({ body: woundView({ status: "healed" }) }),
    });
    const form = within(await openResolve(user));
    await user.click(form.getByRole("button", { name: "Close wound" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect((writesOf(calls)[0] as Call).body).toEqual({ status: "healed" });
  });

  it("a closed wound offers no more observations", async () => {
    const user = userEvent.setup();
    const calls: Call[] = [];
    mount({
      calls,
      routePath: "/patients/:patientId/wounds",
      element: <WoundRegistry />,
      routes: woundRoutes({
        wounds: [listItem({ status: "healed", closedOn: "2026-11-18" })],
      }),
    });
    await user.click(await screen.findByRole("row", { name: /Left heel/ }));
    const drawer = within(await screen.findByRole("complementary", { name: "Wound: Left heel" }));
    await drawer.findByRole("list", { name: "Observations, newest first" });
    expect(drawer.queryByRole("button", { name: "Record observation" })).toBeNull();
    expect(drawer.queryByRole("button", { name: "Mark healed or resolved" })).toBeNull();
  });
});

describe("registering a wound", () => {
  async function openRegister(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("row", { name: /Left heel/ });
    await user.click(screen.getAllByRole("button", { name: /Register wound/ })[0] as HTMLElement);
    return within(await screen.findByRole("form", { name: "Register a wound" }));
  }

  it("the side choices follow the site", async () => {
    const user = userEvent.setup();
    show();
    const form = await openRegister(user);
    const side = form.getByLabelText(/^Side/) as HTMLSelectElement;
    expect(side.disabled).toBe(true);
    await user.selectOptions(form.getByLabelText(/^Site/), "heel");
    expect([...side.options].map((o) => o.value)).toEqual(["", "left", "right", "bilateral"]);
    await user.selectOptions(form.getByLabelText(/^Site/), "sacrum");
    // A midline site has one sensible side, so it is chosen.
    expect([...side.options].map((o) => o.value)).toEqual(["", "midline", "not_applicable"]);
    expect(side.value).toBe("midline");
  });

  it("says what is missing and sends nothing", async () => {
    const user = userEvent.setup();
    const calls = show();
    const form = await openRegister(user);
    await user.click(form.getByRole("button", { name: "Register wound" }));
    expect(await form.findByText("Choose where the wound is.")).toBeTruthy();
    expect(form.getByText("Choose the side that fits this site.")).toBeTruthy();
    expect(form.getByText("Choose what caused the wound.")).toBeTruthy();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("POSTs the site, side, cause and onset, then opens the new wound", async () => {
    const user = userEvent.setup();
    const created = woundView({
      id: SECOND_WOUND_ID,
      siteCode: "sacrum",
      laterality: "midline",
      site: "sacrum",
    });
    const calls = show({
      [`POST ${WOUNDS}`]: () => ({ status: 201, body: created }),
      [`GET ${WOUNDS}/${SECOND_WOUND_ID}`]: () => ({ body: { wound: created, observations: [] } }),
    });
    const form = await openRegister(user);
    await user.selectOptions(form.getByLabelText(/^Site/), "sacrum");
    await user.selectOptions(form.getByLabelText(/^Cause/), "pressure_injury");
    await user.selectOptions(form.getByLabelText("Where it started"), "acquired_in_care");
    await user.type(form.getByLabelText("Onset date"), "2026-11-05");
    await user.click(form.getByRole("button", { name: "Register wound" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect((writesOf(calls)[0] as Call).body).toEqual({
      siteCode: "sacrum",
      laterality: "midline",
      etiology: "pressure_injury",
      acquired: "acquired_in_care",
      onsetOn: "2026-11-05",
    });
    expect(await screen.findByRole("complementary", { name: "Wound: Sacrum" })).toBeTruthy();
  });

  it("shows the server's refusal of a site and side that do not fit", async () => {
    const user = userEvent.setup();
    show({
      [`POST ${WOUNDS}`]: () => ({
        status: 422,
        body: {
          error: { code: "WOUND_SITE_LATERALITY_MISMATCH", message: "laterality does not fit" },
        },
      }),
    });
    const form = await openRegister(user);
    await user.selectOptions(form.getByLabelText(/^Site/), "heel");
    await user.selectOptions(form.getByLabelText(/^Side/), "left");
    await user.selectOptions(form.getByLabelText(/^Cause/), "diabetic_ulcer");
    await user.click(form.getByRole("button", { name: "Register wound" }));
    expect(
      await form.findByText(
        "That side does not fit the site. Choose a side that applies to it, such as midline for the sacrum.",
      ),
    ).toBeTruthy();
  });
});

describe("accessibility", () => {
  it("the register with the observation form open has no axe violations", async () => {
    const user = userEvent.setup();
    show();
    const drawer = await openDrawer(user);
    await user.click(await drawer.findByRole("button", { name: "Record observation" }));
    await screen.findByRole("form", { name: "Record observation" });
    expect(await violations()).toEqual([]);
  });

  it("the history and the registration form have no axe violations", async () => {
    const user = userEvent.setup();
    show();
    const drawer = await openDrawer(user);
    await drawer.findByRole("list", { name: "Observations, newest first" });
    expect(await violations()).toEqual([]);
    await user.click(screen.getAllByRole("button", { name: /Register wound/ })[0] as HTMLElement);
    await screen.findByRole("form", { name: "Register a wound" });
    expect(await violations()).toEqual([]);
  });
});
