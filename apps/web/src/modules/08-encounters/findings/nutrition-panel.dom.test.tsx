import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { PanelStatus } from "../../../shell/panel-status";
import type { NutritionView } from "./findings-api";
import {
  ENCOUNTER_ID,
  type Handler,
  NUTRITION_PATH,
  PATIENT_ID,
  errorReply,
  mountWithApi,
} from "./findings-test-harness";
import { NutritionPanel } from "./nutrition-panel";

/** The version of a stored record is its updated_at in epoch ms; 0 is "nothing stored yet". */
const STORED_VERSION = 1_763_546_400_000;

const STORED: NutritionView = {
  encounterId: ENCOUNTER_ID,
  patientId: PATIENT_ID,
  version: STORED_VERSION,
  appetite: "poor",
  mealIntakePercent: 40,
  fluidIntake: "decreased",
  swallowing: "difficulty_solids",
  support: "oral_supplements",
  updatedAt: "2026-11-19T10:00:00.000Z",
};

/** A server that has `stored` recorded (null: nothing yet) and answers a PUT with the record it was sent. */
function server(stored: NutritionView | null, onPut?: Handler): Handler {
  return (request) => {
    if (request.path !== NUTRITION_PATH) return { status: 404, json: {} };
    if (request.method === "GET") return { json: stored };
    return (
      onPut?.(request) ?? {
        json: {
          ...(request.body as object),
          encounterId: ENCOUNTER_ID,
          patientId: PATIENT_ID,
          version: (stored?.version ?? 0) + 1,
          updatedAt: "2026-11-19T11:00:00.000Z",
        },
      }
    );
  };
}

const mount = (
  handler: Handler,
  props: {
    disabled?: boolean;
    onSaved?: () => void;
    onStatusChange?: (s: PanelStatus) => void;
  } = {},
) => mountWithApi(<NutritionPanel encounterId={ENCOUNTER_ID} {...props} />, handler);

const field = (name: string) => screen.getByRole("combobox", { name });
const meals = () => screen.getByRole("textbox", { name: "Share of meals eaten (%)" });
const save = () => screen.getByRole("button", { name: "Save nutrition" });

describe("NutritionPanel", () => {
  it("loads the recorded nutrition and shows it", async () => {
    mount(server(STORED));

    expect(await screen.findByRole("combobox", { name: "Appetite" })).toHaveValue("poor");
    expect(meals()).toHaveValue("40");
    expect(field("Fluid intake")).toHaveValue("decreased");
    expect(field("Swallowing")).toHaveValue("difficulty_solids");
    expect(field("Nutrition support")).toHaveValue("oral_supplements");
  });

  it("offers every level in plain words, led by Not assessed", async () => {
    mount(server(null));
    await screen.findByRole("combobox", { name: "Appetite" });

    const optionsOf = (name: string) =>
      within(field(name))
        .getAllByRole("option")
        .map((option) => option.textContent);
    expect(optionsOf("Appetite")).toEqual(["Not assessed", "Good", "Fair", "Poor", "None"]);
    expect(optionsOf("Fluid intake")).toEqual(["Not assessed", "Adequate", "Decreased", "Minimal"]);
    expect(optionsOf("Swallowing")).toEqual([
      "Not assessed",
      "No difficulty",
      "Difficulty with solids",
      "Difficulty with liquids",
      "Difficulty with solids and liquids",
      "Unable to swallow",
    ]);
    expect(optionsOf("Nutrition support")).toEqual([
      "Not assessed",
      "None",
      "Oral supplements",
      "Tube feeding",
      "Parenteral",
    ]);
  });

  it("saves the exact PUT body, a whole percent as a number and anything not assessed as null", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const { writes } = mount(server(null), { onSaved });
    await screen.findByRole("combobox", { name: "Appetite" });

    await user.selectOptions(field("Appetite"), "Fair");
    await user.type(meals(), "65");
    await user.selectOptions(field("Swallowing"), "Unable to swallow");
    await user.selectOptions(field("Nutrition support"), "Tube feeding");
    await user.click(save());

    expect(await screen.findByText("Nutrition saved.")).toBeVisible();
    expect(writes()).toEqual([
      {
        method: "PUT",
        path: NUTRITION_PATH,
        ifMatch: "0",
        body: {
          appetite: "fair",
          mealIntakePercent: 65,
          fluidIntake: null,
          swallowing: "unable_to_swallow",
          support: "tube_feeding",
        },
      },
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("replaces the whole record: a field cleared to Not assessed or blank is null in the PUT", async () => {
    const user = userEvent.setup();
    const { writes } = mount(server(STORED));
    await screen.findByRole("combobox", { name: "Appetite" });

    await user.selectOptions(field("Appetite"), "Not assessed");
    await user.clear(meals());
    await user.click(save());

    await screen.findByText("Nutrition saved.");
    expect(writes()[0]?.body).toEqual({
      appetite: null,
      mealIntakePercent: null,
      fluidIntake: "decreased",
      swallowing: "difficulty_solids",
      support: "oral_supplements",
    });
  });

  it("sends a recorded 0 percent as 0, not as not assessed", async () => {
    const user = userEvent.setup();
    const { writes } = mount(server(null));
    await screen.findByRole("combobox", { name: "Appetite" });

    await user.type(meals(), "0");
    await user.click(save());

    await screen.findByText("Nutrition saved.");
    expect(writes()[0]?.body).toMatchObject({ mealIntakePercent: 0 });
  });

  it.each(["101", "12.5", "abc", "-5"])(
    "refuses %j beside the field and sends nothing",
    async (typed) => {
      const user = userEvent.setup();
      const { writes } = mount(server(null));
      await screen.findByRole("combobox", { name: "Appetite" });

      await user.type(meals(), typed);

      expect(meals()).toBeInvalid();
      expect(meals()).toHaveAccessibleDescription(/Enter a whole number from 0 to 100\./);
      expect(save()).toBeDisabled();
      expect(writes()).toEqual([]);
    },
  );

  it("shows a 422 in words and keeps the form editable", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mount(
      server(null, () =>
        errorReply(422, "VALIDATION_FAILED", "request validation failed", [
          {
            field: "mealIntakePercent",
            code: "INVALID",
            message: "must be a whole percent from 0 to 100",
          },
        ]),
      ),
      { onSaved },
    );
    await screen.findByRole("combobox", { name: "Appetite" });

    await user.click(save());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Share of meals eaten: must be a whole percent from 0 to 100",
    );
    expect(field("Appetite")).toBeEnabled();
    expect(save()).toBeEnabled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("goes read-only with a plain sentence when the server says the note is signed (409)", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mount(
      server(STORED, () =>
        errorReply(409, "IMMUTABLE_AFTER_SIGN", "encounter is immutable after signature"),
      ),
      { onSaved },
    );
    await screen.findByRole("combobox", { name: "Appetite" });

    await user.click(save());

    expect(
      await screen.findByText("This note is signed, so these findings can no longer be changed."),
    ).toBeVisible();
    expect(field("Appetite")).toBeDisabled();
    expect(meals()).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(meals()).toHaveValue("40");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("is read-only from the start when disabled (a signed note) and sends nothing", async () => {
    const { writes } = mount(server(STORED), { disabled: true });

    expect(await screen.findByRole("combobox", { name: "Appetite" })).toBeDisabled();
    expect(meals()).toBeDisabled();
    expect(field("Swallowing")).toBeDisabled();
    expect(save()).toBeDisabled();
    expect(writes()).toEqual([]);
  });

  it("does not offer a form it could not load, so a Save cannot replace a record it never saw", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { writes } = mount((request) => {
      if (request.method !== "GET") return { json: {} };
      reads += 1;
      return reads === 1 ? "drop" : { json: STORED };
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The connection was interrupted. Your entries are still here; try again.",
    );
    expect(screen.queryByRole("button", { name: "Save nutrition" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("combobox", { name: "Appetite" })).toHaveValue("poor");
    expect(writes()).toEqual([]);
  });

  it("has no accessibility violations once loaded", async () => {
    const { container } = mount(server(STORED));
    await screen.findByRole("combobox", { name: "Appetite" });

    const results = await axe.run(container);

    expect(results.violations).toEqual([]);
  });

  describe("what it tells the note it sits in", () => {
    it("says a record is stored when it opens on one, and unsaved once the typed share of meals changes", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn();
      mount(server(STORED), { onStatusChange });
      await screen.findByRole("combobox", { name: "Appetite" });
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith({
          dirty: false,
          saving: false,
          recorded: true,
        }),
      );

      await user.clear(meals());
      await user.type(meals(), "55");
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })),
      );

      await user.click(save());
      await screen.findByText("Nutrition saved.");
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith({
          dirty: false,
          saving: false,
          recorded: true,
        }),
      );
    });

    it("counts a share of meals that is not a number as unsaved input", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn();
      mount(server(null), { onStatusChange });
      await screen.findByRole("combobox", { name: "Appetite" });

      await user.type(meals(), "abc");

      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })),
      );
    });
  });

  describe("the version it saves against, and a note that no longer takes it", () => {
    it("sends the version it loaded as If-Match (0 when nothing was stored)", async () => {
      const user = userEvent.setup();
      const stored = mount(server(STORED));
      await screen.findByRole("combobox", { name: "Appetite" });
      await user.click(save());
      await waitFor(() => expect(stored.writes()).toHaveLength(1));
      expect(stored.writes()[0]?.ifMatch).toBe(String(STORED_VERSION));
    });

    it("sends 0 when nothing was stored", async () => {
      const user = userEvent.setup();
      const { writes } = mount(server(null));
      await user.selectOptions(await screen.findByRole("combobox", { name: "Appetite" }), "Good");
      await user.click(save());
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]?.ifMatch).toBe("0");
    });

    it("says the record changed and keeps what was entered until the record is reloaded", async () => {
      const user = userEvent.setup();
      let reads = 0;
      mount((request) => {
        if (request.method === "GET") {
          reads += 1;
          return {
            json:
              reads === 1 ? STORED : { ...STORED, version: STORED_VERSION + 9, appetite: "good" },
          };
        }
        return errorReply(409, "STALE_VERSION", "stale");
      });
      await screen.findByRole("combobox", { name: "Appetite" });
      await user.clear(meals());
      await user.type(meals(), "55");
      await user.click(save());

      expect(await screen.findByText(/This record changed since you opened it\./)).toBeVisible();
      expect(meals()).toHaveValue("55");
      expect(save()).toBeDisabled();

      await user.click(screen.getByRole("button", { name: "Reload the record" }));

      await waitFor(() => expect(field("Appetite")).toHaveValue("good"));
      expect(meals()).toHaveValue("40");
      expect(save()).toBeEnabled();
    });

    it("says the note is finalized (409 NOTE_PINNED_AT_FINALIZE) and goes read-only", async () => {
      const user = userEvent.setup();
      mount(server(STORED, () => errorReply(409, "NOTE_PINNED_AT_FINALIZE", "pinned")));
      await screen.findByRole("combobox", { name: "Appetite" });

      await user.click(save());

      expect(
        await screen.findByText(
          "This note is finalized, so these findings can no longer be changed.",
        ),
      ).toBeVisible();
      expect(field("Appetite")).toBeDisabled();
      expect(save()).toBeDisabled();
    });

    it("says the note has no section for the record (422 FINDING_NOT_IN_NOTE) and goes read-only", async () => {
      const user = userEvent.setup();
      mount(server(STORED, () => errorReply(422, "FINDING_NOT_IN_NOTE", "no section")));
      await screen.findByRole("combobox", { name: "Appetite" });

      await user.click(save());

      expect(
        await screen.findByText(
          "This visit's note has no section for these findings, so they cannot be recorded here.",
        ),
      ).toBeVisible();
      expect(field("Appetite")).toBeDisabled();
    });
  });

  it("discards what was typed and goes back to the stored record", async () => {
    const user = userEvent.setup();
    mount(server(STORED));
    await screen.findByRole("combobox", { name: "Appetite" });

    await user.clear(meals());
    await user.type(meals(), "99");
    await user.selectOptions(field("Appetite"), "Good");
    await user.click(screen.getByRole("button", { name: "Discard changes" }));

    expect(meals()).toHaveValue("40");
    expect(field("Appetite")).toHaveValue("poor");
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();
  });
});
