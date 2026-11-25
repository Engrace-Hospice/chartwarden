// @vitest-environment jsdom
// What the visit note's wound panel tells the composer about itself: `recorded` is true exactly while a wound has an active
// observation tagged to THIS encounter (the note states it), so the composer can show the "Skin and Wounds" section as documented.
// A wound last observed at an earlier visit, a wound with no observation yet, and a wound whose record could not be read do not count.
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { PanelStatus } from "../../../shell/panel-status";
import { VisitWoundsPanel } from "./visit-wounds-panel";
import {
  type Call,
  ENCOUNTER_ID,
  OBSERVATION_ID,
  OTHER_ENCOUNTER_ID,
  PATIENT_ID,
  type Responder,
  SECOND_WOUND_ID,
  WOUND_ID,
  listItem,
  mount,
  observation,
  woundRoutes,
  woundView,
} from "./wound-test-fixture";
import type { WoundListItem, WoundObservation } from "./wounds-api";

const WOUNDS = `/api/v1/patients/${PATIENT_ID}/wounds`;
const WOUND = `${WOUNDS}/${WOUND_ID}`;

const atOtherVisit = observation({ sourceEncounterId: OTHER_ENCOUNTER_ID });
const atThisVisit = observation({ sourceEncounterId: ENCOUNTER_ID, trend: "stable" });

/** Mounts the panel and keeps every status it reports, so a test can read the last one. */
function panel(routes: Record<string, Responder>): { statuses: PanelStatus[]; calls: Call[] } {
  const statuses: PanelStatus[] = [];
  const calls: Call[] = [];
  mount({
    calls,
    routes,
    element: (
      <VisitWoundsPanel
        encounterId={ENCOUNTER_ID}
        patientId={PATIENT_ID}
        onStatusChange={(status) => statuses.push(status)}
      />
    ),
  });
  return { statuses, calls };
}
const lastRecorded = (statuses: readonly PanelStatus[]): boolean | undefined =>
  statuses.at(-1)?.recorded;

describe("the wound panel's recorded status", () => {
  it("is recorded once a wound has an observation at this visit", async () => {
    const { statuses } = panel(woundRoutes({ wounds: [listItem({}, atThisVisit)] }));
    await screen.findByText("Recorded at this visit");
    expect(lastRecorded(statuses)).toBe(true);
  });

  it("is not recorded while the wounds are still loading", () => {
    const { statuses } = panel(woundRoutes({ wounds: [listItem({}, atThisVisit)] }));
    expect(statuses.some((status) => status.recorded === true)).toBe(false);
  });

  it("is not recorded for a patient with no wounds", async () => {
    const { statuses } = panel(woundRoutes({ wounds: [] }));
    await screen.findByText("No wounds recorded for this patient");
    expect(lastRecorded(statuses)).toBe(false);
  });

  it("is not recorded for a wound last observed at an earlier visit", async () => {
    const { statuses } = panel(
      woundRoutes({
        wounds: [listItem({}, atOtherVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
    );
    await screen.findByText("Not recorded at this visit");
    expect(lastRecorded(statuses)).toBe(false);
  });

  it("is not recorded for a wound with no observation at all", async () => {
    const { statuses } = panel(woundRoutes({ wounds: [listItem({}, null)] }));
    await screen.findByText("Not recorded at this visit");
    expect(lastRecorded(statuses)).toBe(false);
  });

  it("is recorded when this visit's observation is not the wound's newest", async () => {
    const later = observation({
      id: "99999999-9999-4999-8999-999999999999",
      sourceEncounterId: OTHER_ENCOUNTER_ID,
    });
    const { statuses } = panel(
      woundRoutes({
        wounds: [listItem({}, later)],
        details: { [WOUND_ID]: [later, atThisVisit] },
      }),
    );
    await screen.findByText("Recorded at this visit");
    expect(lastRecorded(statuses)).toBe(true);
  });

  it("is recorded when only one of two wounds was observed here", async () => {
    const second = {
      id: SECOND_WOUND_ID,
      siteCode: "sacrum",
      laterality: "midline",
      site: "sacrum",
    } as const;
    const { statuses } = panel(
      woundRoutes({
        wounds: [listItem({}, atOtherVisit), listItem(second, atThisVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
    );
    await screen.findByText("Recorded at this visit");
    expect(lastRecorded(statuses)).toBe(true);
  });

  it("does not count a wound whose record could not be read", async () => {
    const { statuses } = panel({
      ...woundRoutes({ wounds: [listItem({}, atOtherVisit)] }),
      [`GET ${WOUND}`]: () => ({ status: 500, body: { error: { code: "INTERNAL" } } }),
    });
    await screen.findByText("Could not be read");
    expect(lastRecorded(statuses)).toBe(false);
  });

  it("counts a wound closed at this visit while its observation here is the latest", async () => {
    const closed = listItem({ status: "healed", closedOn: "2026-11-19" }, atThisVisit);
    const { statuses } = panel(woundRoutes({ wounds: [closed] }));
    await screen.findByText("Recorded at this visit");
    expect(lastRecorded(statuses)).toBe(true);
  });

  it("turns recorded the moment an observation is saved, without a reload of the note", async () => {
    const user = userEvent.setup();
    let latest: WoundObservation | null = atOtherVisit;
    const wound = (): WoundListItem => listItem({}, latest);
    const { statuses } = panel({
      [`GET ${WOUNDS}`]: () => ({ body: { wounds: [wound()] } }),
      [`GET ${WOUND}`]: () => ({
        body: { wound: { ...wound(), latestObservation: undefined }, observations: [latest] },
      }),
      [`POST ${WOUND}/observations`]: () => {
        latest = atThisVisit;
        return { status: 201, body: atThisVisit };
      },
    });
    await user.click(
      await screen.findByRole("button", { name: "Record today's observation: Left heel" }),
    );
    await user.selectOptions(await screen.findByLabelText("Trend"), "stable");
    await user.click(screen.getByRole("button", { name: "Record observation" }));

    await screen.findByText("Recorded at this visit");
    await waitFor(() => expect(lastRecorded(statuses)).toBe(true));
  });

  it("is recorded after a save even when the quiet re-read of the rows fails", async () => {
    const user = userEvent.setup();
    let saved = false;
    const { statuses } = panel({
      [`GET ${WOUNDS}`]: () =>
        saved
          ? { status: 500, body: { error: { code: "INTERNAL" } } }
          : { body: { wounds: [listItem({}, atOtherVisit)] } },
      [`GET ${WOUND}`]: () => ({
        body: {
          wound: { ...listItem({}, atOtherVisit), latestObservation: undefined },
          observations: [atOtherVisit],
        },
      }),
      [`POST ${WOUND}/observations`]: () => {
        saved = true;
        return { status: 201, body: atThisVisit };
      },
    });
    await user.click(
      await screen.findByRole("button", { name: "Record today's observation: Left heel" }),
    );
    await user.selectOptions(await screen.findByLabelText("Trend"), "stable");
    await user.click(screen.getByRole("button", { name: "Record observation" }));

    expect(await screen.findByText(/could not be refreshed after the last change/)).toBeTruthy();
    expect(lastRecorded(statuses)).toBe(true);
  });

  it("stays recorded through a correction of this visit's observation", async () => {
    const user = userEvent.setup();
    const corrected = observation({
      id: "77777777-7777-4777-8777-777777777777",
      sourceEncounterId: ENCOUNTER_ID,
      trend: "worsening",
      version: 1,
      correctsObservationId: OBSERVATION_ID,
    });
    let latest = atThisVisit;
    const { statuses } = panel({
      [`GET ${WOUNDS}`]: () => ({ body: { wounds: [listItem({}, latest)] } }),
      [`POST ${WOUND}/observations/${OBSERVATION_ID}/corrections`]: () => {
        latest = corrected;
        return { status: 201, body: corrected };
      },
    });
    await user.click(
      await screen.findByRole("button", { name: "Correct this visit's observation: Left heel" }),
    );
    await user.selectOptions(
      await screen.findByLabelText(/^Reason for the correction/),
      "wrong_visit",
    );
    await user.click(screen.getByRole("button", { name: "Save correction" }));

    await screen.findByText("Worsening");
    // The section never flickers back to "Not started" while the correction supersedes the old observation.
    const first = statuses.findIndex((status) => status.recorded === true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(statuses.slice(first).every((status) => status.recorded === true)).toBe(true);
  });

  it("is not recorded for a wound registered here but not yet observed", async () => {
    const user = userEvent.setup();
    const created = woundView({
      id: SECOND_WOUND_ID,
      siteCode: "sacrum",
      laterality: "midline",
      site: "sacrum",
    });
    const { statuses } = panel({
      ...woundRoutes({ wounds: [] }),
      [`POST ${WOUNDS}`]: () => ({ status: 201, body: created }),
    });
    await user.click(await screen.findByRole("button", { name: "Add a new wound" }));
    await user.selectOptions(await screen.findByLabelText(/^Site/), "sacrum");
    await user.selectOptions(screen.getByLabelText(/^Cause/), "pressure_injury");
    await user.click(screen.getByRole("button", { name: "Register wound" }));
    await screen.findByRole("form", { name: "Record observation" });
    expect(lastRecorded(statuses)).toBe(false);
  });
});
