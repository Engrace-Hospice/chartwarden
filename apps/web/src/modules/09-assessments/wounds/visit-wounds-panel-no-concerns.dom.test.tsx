// @vitest-environment jsdom
// The wound panel's "No skin or wound concerns at this visit" button. It is the clinician's own statement, added to the section's free
// text as one fixed sentence, never a requirement. The panel holds no text of its own: a host (the composer in the app, a textarea
// here) holds the section's free text, tells the panel what it says, and applies "state" and "undo". The statement must never sit
// beside a recorded wound: the panel takes the exact sentence out when a wound is recorded, and only warns when it cannot.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { type JSX, useState } from "react";
import { describe, expect, it } from "vitest";
import {
  type NoWoundConcernsChange,
  NO_WOUND_CONCERNS_SENTENCE as SENTENCE,
  noWoundConcernsState,
  withoutNoWoundConcerns,
} from "./no-wound-concerns";
import { VisitWoundsPanel } from "./visit-wounds-panel";
import {
  ENCOUNTER_ID,
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

const WOUNDS = `/api/v1/patients/${PATIENT_ID}/wounds`;
const BUTTON = "No skin or wound concerns at this visit";
const RECORDED = "Recorded: no skin or wound concerns at this visit";
const REMOVED = `Removed '${SENTENCE}' because a wound was recorded.`;
const NOTES = "Section notes";

const atThisVisit = observation({ sourceEncounterId: ENCOUNTER_ID, trend: "stable" });
const atOtherVisit = observation({ sourceEncounterId: OTHER_ENCOUNTER_ID });

/** What the composer does with the panel's two changes, reduced to a textarea. */
function Host({
  initialText = "",
  disabled = false,
  withControl = true,
}: {
  initialText?: string;
  disabled?: boolean;
  withControl?: boolean;
}): JSX.Element {
  const [text, setText] = useState(initialText);
  const change = (what: NoWoundConcernsChange): void =>
    setText((held) => {
      if (what === "undo") return withoutNoWoundConcerns(held);
      if (held.includes(SENTENCE)) return held;
      return held.trim() === "" ? SENTENCE : `${held}\n${SENTENCE}`;
    });
  return (
    <>
      <textarea aria-label={NOTES} value={text} onChange={(e) => setText(e.target.value)} />
      <VisitWoundsPanel
        encounterId={ENCOUNTER_ID}
        patientId={PATIENT_ID}
        disabled={disabled}
        {...(withControl
          ? { noConcerns: { state: noWoundConcernsState(text), onChange: change } }
          : {})}
      />
    </>
  );
}

function open(routes: Record<string, Responder>, host: Parameters<typeof Host>[0] = {}): void {
  mount({ calls: [], routes, element: <Host {...host} /> });
}
const noWounds = (): Record<string, Responder> => woundRoutes({ wounds: [] });
const notes = (): HTMLTextAreaElement => screen.getByLabelText(NOTES) as HTMLTextAreaElement;
const button = () => screen.queryByRole("button", { name: BUTTON });

async function violations(): Promise<string[]> {
  const results = await axe.run(document.body, { rules: { region: { enabled: false } } });
  return results.violations.map((v) => `${v.id}: ${v.help}`);
}

describe("offering the statement", () => {
  it("is a button beside 'Add a new wound' when the patient has no wound on file", async () => {
    open(noWounds());
    expect(await screen.findByText("No wounds recorded for this patient")).toBeTruthy();
    expect(screen.getByRole("button", { name: BUTTON })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a new wound" })).toBeTruthy();
  });

  it("is not offered when the composer gives the panel no control for it", async () => {
    open(noWounds(), { withControl: false });
    await screen.findByText("No wounds recorded for this patient");
    expect(button()).toBeNull();
  });

  it("is not offered when a wound is on file, whether it was recorded at this visit or not", async () => {
    open(woundRoutes({ wounds: [listItem({}, atThisVisit)] }));
    expect(await screen.findByText("Recorded at this visit")).toBeTruthy();
    expect(button()).toBeNull();
  });

  it("is not offered for a wound last observed at an earlier visit either", async () => {
    open(
      woundRoutes({
        wounds: [listItem({}, atOtherVisit)],
        details: { [WOUND_ID]: [atOtherVisit] },
      }),
    );
    expect(await screen.findByText("Not recorded at this visit")).toBeTruthy();
    expect(button()).toBeNull();
  });

  it("is not offered, and no Add button either, once the note is read-only", async () => {
    open(noWounds(), { disabled: true });
    expect(
      await screen.findByText("Nothing was recorded about a wound at this visit."),
    ).toBeTruthy();
    expect(button()).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a new wound" })).toBeNull();
  });
});

describe("stating it and undoing it", () => {
  it("adds the one sentence below what was typed, then shows the recorded state with an Undo that has focus", async () => {
    const user = userEvent.setup();
    open(noWounds(), { initialText: "Skin warm and dry." });
    await user.click(await screen.findByRole("button", { name: BUTTON }));

    expect(notes().value).toBe(`Skin warm and dry.\n${SENTENCE}`);
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(RECORDED);
    expect(button()).toBeNull();
    const undo = screen.getByRole("button", { name: /^Undo/ });
    expect(undo).toHaveFocus();
    expect(screen.getByRole("button", { name: "Add a new wound" })).toBeTruthy();
  });

  it("Undo takes out exactly that sentence, leaves what else was typed, and gives the button back with focus", async () => {
    const user = userEvent.setup();
    open(noWounds(), { initialText: "Skin warm and dry." });
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    await user.type(notes(), " Family at bedside.");
    expect(notes().value).toBe(`Skin warm and dry.\n${SENTENCE} Family at bedside.`);

    await user.click(screen.getByRole("button", { name: /^Undo/ }));

    expect(notes().value).toBe("Skin warm and dry.\nFamily at bedside.");
    expect(screen.queryByText(RECORDED)).toBeNull();
    expect(screen.getByRole("button", { name: BUTTON })).toHaveFocus();
  });

  it("has no accessibility violations in the recorded state", async () => {
    const user = userEvent.setup();
    open(noWounds());
    await user.click(await screen.findByRole("button", { name: BUTTON }));
    await screen.findByText(RECORDED);
    expect(await violations()).toEqual([]);
  });

  it("reads a sentence already in the notes as stated: the recorded line shows, the button does not", async () => {
    open(noWounds(), { initialText: `Skin warm.\n${SENTENCE}` });
    expect(await screen.findByText(RECORDED)).toBeTruthy();
    expect(button()).toBeNull();
  });

  it("shows the recorded line but no Undo once the note is read-only", async () => {
    open(noWounds(), { initialText: SENTENCE, disabled: true });
    expect(await screen.findByText(RECORDED)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(notes().value).toBe(SENTENCE);
  });

  it("says so, with no button, when the notes already say it in the clinician's own words", async () => {
    open(noWounds(), { initialText: "No skin breakdown or wounds today, heels checked." });
    expect(
      await screen.findByText(/Your notes already say there is no skin breakdown or wound/),
    ).toBeTruthy();
    expect(button()).toBeNull();
  });
});

describe("never beside a recorded wound", () => {
  /** The wound list is empty until the patient's wound is registered here, as it is for a clinician who finds one mid-visit. */
  function registerRoutes(): Record<string, Responder> {
    let registered = false;
    const created = woundView({
      id: SECOND_WOUND_ID,
      siteCode: "sacrum",
      laterality: "midline",
      site: "sacrum",
    });
    return {
      [`GET ${WOUNDS}`]: () => ({
        body: { wounds: registered ? [{ ...created, latestObservation: null }] : [] },
      }),
      [`POST ${WOUNDS}`]: () => {
        registered = true;
        return { status: 201, body: created };
      },
    };
  }

  it("takes the exact sentence out when a wound is recorded after it, keeps the rest, and says so in one line", async () => {
    const user = userEvent.setup();
    open(registerRoutes(), { initialText: `Skin warm and dry.\n${SENTENCE}` });
    await screen.findByText(RECORDED);

    await user.click(screen.getByRole("button", { name: "Add a new wound" }));
    const register = within(await screen.findByRole("form", { name: "Register a wound" }));
    await user.selectOptions(register.getByLabelText(/^Site/), "sacrum");
    await user.selectOptions(register.getByLabelText(/^Cause/), "pressure_injury");
    await user.click(register.getByRole("button", { name: "Register wound" }));

    expect(await screen.findByText(REMOVED)).toBeTruthy();
    expect(notes().value).toBe("Skin warm and dry.");
    expect(screen.queryByText(RECORDED)).toBeNull();
    expect(screen.queryByText(/but a wound is recorded/)).toBeNull();
  });

  it("takes it out on load too, when the saved note says it and a wound is on file", async () => {
    open(woundRoutes({ wounds: [listItem({}, atThisVisit)] }), {
      initialText: `Skin warm.\n${SENTENCE}`,
    });
    expect(await screen.findByText(REMOVED)).toBeTruthy();
    expect(notes().value).toBe("Skin warm.");
  });

  it("does not touch a sentence the clinician edited, and warns that the note says there are no wounds", async () => {
    const edited =
      "No skin breakdown or wounds were identified at this visit, except the left heel";
    open(woundRoutes({ wounds: [listItem({}, atThisVisit)] }), { initialText: edited });

    const warning = await screen.findByText(/The notes say there is no skin breakdown or wound/);
    expect(warning.textContent).toMatch(/a wound is recorded for this patient/);
    expect(notes().value).toBe(edited);
    expect(screen.queryByText(REMOVED)).toBeNull();
  });

  it("only warns, and removes nothing, while the note is read-only", async () => {
    open(woundRoutes({ wounds: [listItem({}, atThisVisit)] }), {
      initialText: SENTENCE,
      disabled: true,
    });

    expect(
      await screen.findByText(/The notes say there is no skin breakdown or wound/),
    ).toBeTruthy();
    expect(notes().value).toBe(SENTENCE);
    await waitFor(() => expect(screen.queryByText(REMOVED)).toBeNull());
  });

  it("says nothing when the notes make no such statement and a wound is on file", async () => {
    open(woundRoutes({ wounds: [listItem({}, atThisVisit)] }), {
      initialText: "Dressing changed.",
    });
    await screen.findByText("Recorded at this visit");
    expect(screen.queryByText(/The notes say/)).toBeNull();
    expect(screen.queryByText(REMOVED)).toBeNull();
    expect(notes().value).toBe("Dressing changed.");
  });
});
