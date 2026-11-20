// @vitest-environment jsdom
// The visit note's wound panel. The note does not hold wound data: it STATES the observations recorded at its encounter.
// So the panel reads the patient's wounds, says for each whether an observation tagged to THIS encounter exists, and
// records or corrects it through the same form the Wounds screen uses, with `sourceEncounterId` set to the encounter.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
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
  writesOf,
} from "./wound-test-fixture";
import { WOUND_ERROR_COPY } from "./wounds-api";

const WOUNDS = `/api/v1/patients/${PATIENT_ID}/wounds`;
const WOUND = `${WOUNDS}/${WOUND_ID}`;

const RECORD_HEEL = "Record today's observation: Left heel";
const RECORD_ANY = /^Record today's observation/;

const atOtherVisit = observation({ sourceEncounterId: OTHER_ENCOUNTER_ID });
const atThisVisit = observation({ sourceEncounterId: ENCOUNTER_ID, trend: "stable" });

function panel(opts: {
  routes: Record<string, Responder>;
  disabled?: boolean;
  onChanged?: () => void;
}): Call[] {
  const calls: Call[] = [];
  mount({
    calls,
    routes: opts.routes,
    element: (
      <VisitWoundsPanel
        encounterId={ENCOUNTER_ID}
        patientId={PATIENT_ID}
        {...(opts.disabled === undefined ? {} : { disabled: opts.disabled })}
        {...(opts.onChanged ? { onChanged: opts.onChanged } : {})}
      />
    ),
  });
  return calls;
}

/** The panel as the composer holds it: a toggle stands for the composer going busy (a draft save) and coming back. */
function BusyHost({ onStatus }: { onStatus: (status: PanelStatus) => void }): JSX.Element {
  const [disabled, setDisabled] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setDisabled((held) => !held)}>
        Toggle busy
      </button>
      <VisitWoundsPanel
        encounterId={ENCOUNTER_ID}
        patientId={PATIENT_ID}
        disabled={disabled}
        onStatusChange={onStatus}
      />
    </>
  );
}

/** Axe over the whole page. The `region` rule asks the PAGE to put its content in landmarks, which the app shell does and a test mount has no shell for. */
async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, { rules: { region: { enabled: false } } });
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

describe("the visit note's wound panel", () => {
  it("says no wounds are recorded and offers to add one", async () => {
    panel({ routes: woundRoutes({ wounds: [] }) });
    expect(await screen.findByText("No wounds recorded for this patient")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a new wound" })).toBeTruthy();
  });

  it("a wound with no observation at this visit says so and shows the last one", async () => {
    // The newest observation was made at another visit; this visit's is not on the wound yet.
    const calls = panel({
      routes: woundRoutes({
        wounds: [listItem({}, atOtherVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
    });
    const row = within(await screen.findByRole("listitem"));
    expect(await row.findByText("Not recorded at this visit")).toBeTruthy();
    expect(row.getByText(/^Last observed .*: 3\.0 × 2\.0 cm \(area 6 cm²\)\.$/)).toBeTruthy();
    expect(row.getByRole("button", { name: RECORD_HEEL })).toBeTruthy();
    // The wound is read in full, because this visit's observation may not be its newest.
    expect(calls.some((c) => c.method === "GET" && c.path === WOUND)).toBe(true);
  });

  it("records today's observation tagged to THIS encounter and tells the composer", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const calls = panel({
      onChanged,
      routes: {
        ...woundRoutes({
          wounds: [listItem({}, atOtherVisit)],
          details: { [WOUND_ID]: [atOtherVisit] },
        }),
        [`POST ${WOUND}/observations`]: () => ({ status: 201, body: atThisVisit }),
      },
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    // It opens empty: the panel prefills nothing it cannot know.
    expect((form.getByLabelText("Length (cm)") as HTMLInputElement).value).toBe("");
    await user.type(form.getByLabelText("Length (cm)"), "3");
    await user.type(form.getByLabelText("Width (cm)"), "2");
    await user.selectOptions(form.getByLabelText("Trend"), "stable");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    const write = writesOf(calls)[0] as Call;
    expect(write.path).toBe(`${WOUND}/observations`);
    expect(write.body).toEqual({
      lengthCm: 3,
      widthCm: 2,
      trend: "stable",
      sourceEncounterId: ENCOUNTER_ID,
    });
    // The write DECLARES an Idempotency-Key, so a lost reply can be retried without doubling the observation.
    expect(write.headers.get("idempotency-key")).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    // The form is gone once it is saved.
    expect(screen.queryByRole("form", { name: "Record observation" })).toBeNull();
  });

  it("a wound already observed at this visit shows what was recorded and is not read again", async () => {
    const calls = panel({
      routes: woundRoutes({ wounds: [listItem({}, atThisVisit)] }),
    });
    const row = within(await screen.findByRole("listitem"));
    expect(await row.findByText("Recorded at this visit")).toBeTruthy();
    expect(row.getByText("Granulation")).toBeTruthy();
    expect(row.getByText("Stable")).toBeTruthy();
    expect(row.queryByRole("button", { name: RECORD_ANY })).toBeNull();
    // The list's latest observation already answers it: no second read of the wound.
    expect(calls.some((c) => c.method === "GET" && c.path === WOUND)).toBe(false);
  });

  it("finds this visit's observation even when a later one exists", async () => {
    const later = observation({
      id: "99999999-9999-4999-8999-999999999999",
      sourceEncounterId: OTHER_ENCOUNTER_ID,
    });
    panel({
      routes: woundRoutes({
        wounds: [listItem({}, later)],
        details: { [WOUND_ID]: [later, atThisVisit] },
      }),
    });
    expect(await screen.findByText("Recorded at this visit")).toBeTruthy();
  });

  it("corrects this visit's observation, keeping the visit and pinning its version", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const calls = panel({
      onChanged,
      routes: {
        ...woundRoutes({ wounds: [listItem({}, atThisVisit)] }),
        [`POST ${WOUND}/observations/${OBSERVATION_ID}/corrections`]: () => ({
          status: 201,
          body: atThisVisit,
        }),
      },
    });
    await user.click(
      await screen.findByRole("button", { name: "Correct this visit's observation: Left heel" }),
    );
    const form = within(await screen.findByRole("form", { name: "Correct observation" }));
    await user.selectOptions(form.getByLabelText(/^Reason for the correction/), "wrong_visit");
    await user.click(form.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    const write = writesOf(calls)[0] as Call;
    expect(write.headers.get("if-match")).toBe("3");
    expect(write.headers.get("idempotency-key")).toBeTruthy();
    expect(write.body).toMatchObject({
      sourceEncounterId: ENCOUNTER_ID,
      correctionReason: "wrong_visit",
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("registers a wound found at this visit and goes straight to its first observation", async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const created = woundView({
      id: SECOND_WOUND_ID,
      siteCode: "sacrum",
      laterality: "midline",
      site: "sacrum",
    });
    const firstObservation = observation({
      id: "88888888-8888-4888-8888-888888888888",
      woundId: SECOND_WOUND_ID,
      sourceEncounterId: ENCOUNTER_ID,
    });
    const calls = panel({
      onChanged,
      routes: {
        ...woundRoutes({ wounds: [] }),
        [`POST ${WOUNDS}`]: () => ({ status: 201, body: created }),
        [`POST ${WOUNDS}/${SECOND_WOUND_ID}/observations`]: () => ({
          status: 201,
          body: firstObservation,
        }),
      },
    });
    await user.click(await screen.findByRole("button", { name: "Add a new wound" }));
    const register = within(await screen.findByRole("form", { name: "Register a wound" }));
    await user.selectOptions(register.getByLabelText(/^Site/), "sacrum");
    await user.selectOptions(register.getByLabelText(/^Cause/), "pressure_injury");
    await user.click(register.getByRole("button", { name: "Register wound" }));
    // Straight to the first observation of the new wound.
    expect(await screen.findByText("Record today's observation: Sacrum")).toBeTruthy();
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    await user.selectOptions(form.getByLabelText("Trend"), "new");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    const second = writesOf(calls)[1] as Call;
    expect(second.path).toBe(`${WOUNDS}/${SECOND_WOUND_ID}/observations`);
    expect(second.body).toEqual({ trend: "new", sourceEncounterId: ENCOUNTER_ID });
    // Registering the wound and recording its first observation each carry a key of their own.
    const keys = writesOf(calls).map((write) => write.headers.get("idempotency-key"));
    expect(keys.every((key) => typeof key === "string" && key !== "")).toBe(true);
    expect(new Set(keys).size).toBe(2);
    // A write fires `onChanged` each time, so the note preview never lags the wound record.
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it("when the note is locked it reads and offers no write", async () => {
    panel({
      disabled: true,
      routes: woundRoutes({
        wounds: [
          listItem({}, atOtherVisit),
          listItem(
            { id: SECOND_WOUND_ID, siteCode: "sacrum", laterality: "midline", site: "sacrum" },
            atThisVisit,
          ),
        ],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
    });
    expect(await screen.findByText("Recorded at this visit")).toBeTruthy();
    expect(screen.getByText("Not recorded at this visit")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a wound closed at this visit, as recorded, with no further observation offered", async () => {
    panel({
      routes: woundRoutes({
        wounds: [listItem({ status: "healed", closedOn: "2026-11-19" }, atThisVisit)],
      }),
    });
    const row = within(await screen.findByRole("listitem"));
    expect(await row.findByText("Recorded at this visit")).toBeTruthy();
    expect(row.getByText(/Healed/)).toBeTruthy();
    expect(row.queryByRole("button", { name: RECORD_ANY })).toBeNull();
  });

  it("a failed read is announced with a retry", async () => {
    panel({
      routes: { [`GET ${WOUNDS}`]: () => ({ status: 500, body: { error: { code: "INTERNAL" } } }) },
    });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("has no axe violations with a wound and its form open", async () => {
    const user = userEvent.setup();
    panel({
      routes: woundRoutes({
        wounds: [listItem({}, atOtherVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    await screen.findByRole("form", { name: "Record observation" });
    expect(await violations()).toEqual([]);
  });

  it("names each wound on its own action, so two wounds do not share one button name", async () => {
    panel({
      routes: woundRoutes({
        wounds: [
          listItem({}, atOtherVisit),
          listItem(
            { id: SECOND_WOUND_ID, siteCode: "sacrum", laterality: "midline", site: "sacrum" },
            observation({ woundId: SECOND_WOUND_ID, sourceEncounterId: OTHER_ENCOUNTER_ID }),
          ),
        ],
      }),
    });
    expect(await screen.findByRole("button", { name: RECORD_HEEL })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record today's observation: Sacrum" })).toBeTruthy();
  });

  it("keeps an open form, and what was typed in it, when the note goes busy and comes back", async () => {
    const user = userEvent.setup();
    const statuses: PanelStatus[] = [];
    const calls: Call[] = [];
    mount({
      calls,
      routes: woundRoutes({
        wounds: [listItem({}, atOtherVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
      element: <BusyHost onStatus={(status) => statuses.push(status)} />,
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const length = (): HTMLInputElement => screen.getByLabelText("Length (cm)") as HTMLInputElement;
    await user.type(length(), "3");
    await waitFor(() => expect(statuses.at(-1)?.dirty).toBe(true));

    await user.click(screen.getByRole("button", { name: "Toggle busy" }));
    // The composer is saving the draft: the form stays, read-only, with the typed value in it.
    expect(length().value).toBe("3");
    // Read-only through the fieldset around the form, not through the input's own attribute.
    expect(length().matches(":disabled")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Toggle busy" }));
    expect(length().value).toBe("3");
    expect(length().matches(":disabled")).toBe(false);
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("is not dirty until something is typed, and not again once the form is cancelled", async () => {
    const user = userEvent.setup();
    const statuses: PanelStatus[] = [];
    mount({
      calls: [],
      routes: woundRoutes({
        wounds: [listItem({}, atOtherVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
      element: <BusyHost onStatus={(status) => statuses.push(status)} />,
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    expect(statuses.at(-1)?.dirty ?? false).toBe(false);

    await user.type(form.getByLabelText("Length (cm)"), "3");
    await waitFor(() => expect(statuses.at(-1)?.dirty).toBe(true));

    await user.click(form.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(statuses.at(-1)?.dirty).toBe(false));
  });

  it("keeps the first-observation form of a newly added wound, and what was typed, once the list catches up", async () => {
    const user = userEvent.setup();
    const created = woundView({
      id: SECOND_WOUND_ID,
      siteCode: "sacrum",
      laterality: "midline",
      site: "sacrum",
    });
    let registered = false;
    panel({
      routes: {
        [`GET ${WOUNDS}`]: () => ({
          body: { wounds: registered ? [{ ...created, latestObservation: null }] : [] },
        }),
        [`POST ${WOUNDS}`]: () => {
          registered = true;
          return { status: 201, body: created };
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: "Add a new wound" }));
    const register = within(await screen.findByRole("form", { name: "Register a wound" }));
    await user.selectOptions(register.getByLabelText(/^Site/), "sacrum");
    await user.selectOptions(register.getByLabelText(/^Cause/), "pressure_injury");
    await user.click(register.getByRole("button", { name: "Register wound" }));
    const length = (await screen.findByLabelText("Length (cm)")) as HTMLInputElement;
    await user.type(length, "4");

    // The list re-reads and now holds the wound: the form is the same element, not a new one in a new place.
    expect(await screen.findByRole("listitem")).toBeTruthy();
    expect(screen.getByLabelText("Length (cm)")).toBe(length);
    expect(length.value).toBe("4");
  });

  it("marks only the wound whose read failed, and leaves the others recordable", async () => {
    const second = listItem(
      { id: SECOND_WOUND_ID, siteCode: "sacrum", laterality: "midline", site: "sacrum" },
      observation({ woundId: SECOND_WOUND_ID, sourceEncounterId: OTHER_ENCOUNTER_ID }),
    );
    panel({
      routes: {
        ...woundRoutes({ wounds: [listItem({}, atOtherVisit), second] }),
        [`GET ${WOUND}`]: () => ({ status: 500, body: { error: { code: "INTERNAL" } } }),
      },
    });
    expect(await screen.findByText("Could not be read")).toBeTruthy();
    // The wound that read fine can still be recorded; the one that did not offers no record that could duplicate.
    expect(screen.getByRole("button", { name: "Record today's observation: Sacrum" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: RECORD_HEEL })).toBeNull();
    expect(screen.getByRole("button", { name: "Try again: Left heel" })).toBeTruthy();
  });

  it("says the list may be out of date when the re-read after a save fails, and offers no second record until it is read", async () => {
    const user = userEvent.setup();
    let listReads = 0;
    panel({
      routes: {
        ...woundRoutes({
          wounds: [listItem({}, atOtherVisit)],
          details: { [WOUND_ID]: [atOtherVisit] },
        }),
        [`GET ${WOUNDS}`]: () => {
          listReads += 1;
          return listReads === 2
            ? { status: 500, body: { error: { code: "INTERNAL" } } }
            : { body: { wounds: [listItem({}, atOtherVisit)] } };
        },
        [`POST ${WOUND}/observations`]: () => ({ status: 201, body: atThisVisit }),
      },
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    await user.type(form.getByLabelText("Length (cm)"), "3");
    await user.type(form.getByLabelText("Width (cm)"), "2");
    await user.click(form.getByRole("button", { name: "Record observation" }));

    expect(await screen.findByText(/could not be refreshed after the last change/)).toBeTruthy();
    // The row still says "Not recorded", but its Record button is off: recording again would duplicate the observation.
    const record = screen.getByRole("button", { name: RECORD_HEEL }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Refresh wounds" }));
    await waitFor(() =>
      expect(screen.queryByText(/could not be refreshed after the last change/)).toBeNull(),
    );
  });

  it("sends a retry of an observation whose reply was lost under the same Idempotency-Key", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = panel({
      routes: {
        ...woundRoutes({
          wounds: [listItem({}, atOtherVisit)],
          details: { [WOUND_ID]: [atOtherVisit] },
        }),
        [`POST ${WOUND}/observations`]: () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError("connection dropped");
          return { status: 201, body: atThisVisit };
        },
      },
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    await user.type(form.getByLabelText("Length (cm)"), "3");
    await user.type(form.getByLabelText("Width (cm)"), "2");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    // No answer: the form is still there with what was typed, and the same write goes out again.
    await waitFor(() => expect(attempts).toBe(1));
    await user.click(await screen.findByRole("button", { name: "Record observation" }));

    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    const [first, second] = writesOf(calls) as [Call, Call];
    expect(first.headers.get("idempotency-key")).toBeTruthy();
    expect(second.headers.get("idempotency-key")).toBe(first.headers.get("idempotency-key"));
  });

  it("renders the sentence the wound error copy gives for a refusal, whatever the code", async () => {
    const user = userEvent.setup();
    panel({
      routes: {
        ...woundRoutes({
          wounds: [listItem({}, atOtherVisit)],
          details: { [WOUND_ID]: [atOtherVisit] },
        }),
        [`POST ${WOUND}/observations`]: () => ({
          status: 422,
          body: { error: { code: "WOUND_NOT_IN_NOTE", message: "no section" } },
        }),
      },
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    await user.type(form.getByLabelText("Length (cm)"), "3");
    await user.type(form.getByLabelText("Width (cm)"), "2");
    await user.click(form.getByRole("button", { name: "Record observation" }));

    expect(await screen.findByText(WOUND_ERROR_COPY.WOUND_NOT_IN_NOTE as string)).toBeTruthy();
    // The form keeps what was typed, for another try.
    expect((screen.getByLabelText("Length (cm)") as HTMLInputElement).value).toBe("3");
  });

  it("does not offer to add a wound while an observation form is open, so the form is not unmounted", async () => {
    const user = userEvent.setup();
    panel({
      routes: woundRoutes({
        wounds: [listItem({}, atOtherVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    await user.type(form.getByLabelText("Length (cm)"), "3");

    const add = screen.getByRole("button", { name: "Add a new wound" });
    expect(add).toBeDisabled();
    expect((screen.getByLabelText("Length (cm)") as HTMLInputElement).value).toBe("3");

    await user.click(form.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Add a new wound" })).toBeEnabled();
  });

  it("reads the rows again when a correction is refused because the observation moved on, and sends the retry against the current one", async () => {
    const user = userEvent.setup();
    const current = observation({ sourceEncounterId: ENCOUNTER_ID, trend: "stable", version: 3 });
    const moved = observation({ sourceEncounterId: ENCOUNTER_ID, trend: "improving", version: 4 });
    let listReads = 0;
    let corrections = 0;
    const calls = panel({
      routes: {
        [`GET ${WOUNDS}`]: () => {
          listReads += 1;
          return { body: { wounds: [listItem({}, listReads === 1 ? current : moved)] } };
        },
        [`POST ${WOUND}/observations/${OBSERVATION_ID}/corrections`]: () => {
          corrections += 1;
          return corrections === 1
            ? { status: 409, body: { error: { code: "STALE_VERSION", message: "stale" } } }
            : { status: 201, body: moved };
        },
      },
    });
    await user.click(
      await screen.findByRole("button", { name: "Correct this visit's observation: Left heel" }),
    );
    const form = within(await screen.findByRole("form", { name: "Correct observation" }));
    await user.selectOptions(form.getByLabelText(/^Reason for the correction/), "wrong_visit");
    await user.click(form.getByRole("button", { name: "Save correction" }));

    // The refusal is shown, the rows are read again, and the form still holds the chosen reason.
    expect(await screen.findByText(WOUND_ERROR_COPY.STALE_VERSION as string)).toBeTruthy();
    await waitFor(() => expect(listReads).toBe(2));
    expect((screen.getByLabelText(/^Reason for the correction/) as HTMLSelectElement).value).toBe(
      "wrong_visit",
    );

    await user.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls).map((write) => write.headers.get("if-match"))).toEqual(["3", "4"]);
  });

  it("hands focus to the panel when Refresh wounds replaces the stale warning", async () => {
    const user = userEvent.setup();
    let listReads = 0;
    panel({
      routes: {
        ...woundRoutes({
          wounds: [listItem({}, atOtherVisit)],
          details: { [WOUND_ID]: [atOtherVisit] },
        }),
        [`GET ${WOUNDS}`]: () => {
          listReads += 1;
          return listReads === 2
            ? { status: 500, body: { error: { code: "INTERNAL" } } }
            : { body: { wounds: [listItem({}, atOtherVisit)] } };
        },
        [`POST ${WOUND}/observations`]: () => ({ status: 201, body: atThisVisit }),
      },
    });
    await user.click(await screen.findByRole("button", { name: RECORD_HEEL }));
    const form = within(await screen.findByRole("form", { name: "Record observation" }));
    await user.type(form.getByLabelText("Length (cm)"), "3");
    await user.type(form.getByLabelText("Width (cm)"), "2");
    await user.click(form.getByRole("button", { name: "Record observation" }));
    await screen.findByText(/could not be refreshed after the last change/);

    const refresh = screen.getByRole("button", { name: "Refresh wounds" });
    refresh.focus();
    await user.click(refresh);

    await waitFor(() =>
      expect(screen.queryByText(/could not be refreshed after the last change/)).toBeNull(),
    );
    expect(screen.getByRole("region", { name: "Wounds" })).toHaveFocus();
  });
});
