import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { PanelStatus } from "../../../shell/panel-status";
import { AdlPanel } from "./adl-panel";
import type { AdlView } from "./findings-api";
import {
  ADL_PATH,
  ENCOUNTER_ID,
  type Handler,
  PATIENT_ID,
  errorReply,
  mountWithApi,
} from "./findings-test-harness";

/** The version of a stored record is its updated_at in epoch ms; 0 is "nothing stored yet". */
const STORED_VERSION = 1_763_546_400_000;

const STORED: AdlView = {
  encounterId: ENCOUNTER_ID,
  patientId: PATIENT_ID,
  version: STORED_VERSION,
  items: { bathing: "limited_assist", eating: "independent" },
  bladder: "continent",
  bowel: null,
  devices: ["walker", "hospital_bed"],
  updatedAt: "2026-11-19T10:00:00.000Z",
};

/** A server that has `stored` recorded (null: nothing yet) and answers a PUT with the record it was sent. */
function server(stored: AdlView | null, onPut?: Handler): Handler {
  return (request) => {
    if (request.path !== ADL_PATH) return { status: 404, json: {} };
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
) => mountWithApi(<AdlPanel encounterId={ENCOUNTER_ID} {...props} />, handler);

const levelOf = (activity: string) => screen.getByRole("combobox", { name: activity });

describe("AdlPanel", () => {
  it("loads the recorded ADLs and shows them", async () => {
    mount(server(STORED));

    expect(await screen.findByRole("combobox", { name: "Bathing" })).toHaveValue("limited_assist");
    expect(levelOf("Eating")).toHaveValue("independent");
    expect(levelOf("Dressing")).toHaveValue("");
    expect(within(levelOf("Dressing")).getByRole("option", { name: "Not assessed" })).toBeVisible();
    expect(levelOf("Bladder")).toHaveValue("continent");
    expect(levelOf("Bowel")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Walker" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Hospital bed" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Cane" })).not.toBeChecked();
  });

  it("offers every activity, level, continence level and device in plain words", async () => {
    mount(server(null));

    await screen.findByRole("combobox", { name: "Bathing" });
    for (const activity of [
      "Bathing",
      "Dressing",
      "Grooming",
      "Toileting",
      "Transferring",
      "Ambulation",
      "Eating",
    ]) {
      expect(
        within(levelOf(activity))
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual([
        "Not assessed",
        "Independent",
        "Supervision",
        "Limited assist",
        "Extensive assist",
        "Total dependence",
        "Did not occur",
      ]);
    }
    expect(
      within(levelOf("Bladder"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      "Not assessed",
      "Continent",
      "Occasionally incontinent",
      "Frequently incontinent",
      "Incontinent",
      "Catheter or ostomy",
    ]);
    expect(screen.getAllByRole("checkbox").map((box) => box.parentElement?.textContent)).toEqual([
      "Cane",
      "Walker",
      "Wheelchair",
      "Hospital bed",
      "Mechanical lift",
      "Bedside commode",
    ]);
  });

  it("saves the exact PUT body: assessed items only, null continence when not assessed, devices in documented order", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    const { writes } = mount(server(null), { onSaved });
    await screen.findByRole("combobox", { name: "Bathing" });

    await user.selectOptions(levelOf("Bathing"), "Extensive assist");
    await user.selectOptions(levelOf("Toileting"), "Total dependence");
    await user.selectOptions(levelOf("Bladder"), "Catheter or ostomy");
    await user.click(screen.getByRole("checkbox", { name: "Walker" }));
    await user.click(screen.getByRole("checkbox", { name: "Cane" }));
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByText("ADLs saved.")).toBeVisible();
    expect(writes()).toEqual([
      {
        method: "PUT",
        path: ADL_PATH,
        // Nothing was stored when the form opened, so the save asks the server to still hold nothing.
        ifMatch: "0",
        body: {
          items: { bathing: "extensive_assist", toileting: "total_dependence" },
          bladder: "catheter_or_ostomy",
          bowel: null,
          devices: ["cane", "walker"],
        },
      },
    ]);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("replaces the whole record: an activity set back to Not assessed is absent from the PUT", async () => {
    const user = userEvent.setup();
    const { writes } = mount(server(STORED));
    await screen.findByRole("combobox", { name: "Bathing" });

    await user.selectOptions(levelOf("Bathing"), "Not assessed");
    await user.click(screen.getByRole("checkbox", { name: "Walker" }));
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    await screen.findByText("ADLs saved.");
    expect(writes()[0]?.body).toEqual({
      items: { eating: "independent" },
      bladder: "continent",
      bowel: null,
      devices: ["hospital_bed"],
    });
  });

  it("drops the saved confirmation as soon as the form is edited again", async () => {
    const user = userEvent.setup();
    mount(server(null));
    await screen.findByRole("combobox", { name: "Bathing" });

    await user.click(screen.getByRole("button", { name: "Save ADLs" }));
    expect(await screen.findByText("ADLs saved.")).toBeVisible();
    await user.selectOptions(levelOf("Dressing"), "Supervision");

    expect(screen.queryByText("ADLs saved.")).toBeNull();
  });

  it("shows a 422 in words, keeps the form editable and does not report a save", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    mount(
      server(null, () =>
        errorReply(422, "VALIDATION_FAILED", "request validation failed", [
          {
            field: "items.bathing",
            code: "INVALID",
            message: "must be one of: independent, supervision",
          },
        ]),
      ),
      { onSaved },
    );
    await screen.findByRole("combobox", { name: "Bathing" });

    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Bathing: Choose one of the listed options.",
    );
    expect(levelOf("Bathing")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save ADLs" })).toBeEnabled();
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
    await screen.findByRole("combobox", { name: "Bathing" });

    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(
      await screen.findByText("This note is signed, so these findings can no longer be changed."),
    ).toBeVisible();
    expect(levelOf("Bathing")).toBeDisabled();
    expect(levelOf("Bladder")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Walker" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save ADLs" })).toBeDisabled();
    expect(levelOf("Bathing")).toHaveValue("limited_assist");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("is read-only from the start when disabled (a signed note) and sends nothing", async () => {
    const { writes } = mount(server(STORED), { disabled: true });

    expect(await screen.findByRole("combobox", { name: "Bathing" })).toBeDisabled();
    expect(levelOf("Eating")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Cane" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save ADLs" })).toBeDisabled();
    expect(levelOf("Bathing")).toHaveValue("limited_assist");
    expect(writes()).toEqual([]);
  });

  it("does not offer a form it could not load, so a Save cannot replace a record it never saw", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { writes } = mount((request) => {
      if (request.method !== "GET") return { json: {} };
      reads += 1;
      return reads === 1
        ? errorReply(500, "INTERNAL", "The service is unavailable.")
        : { json: STORED };
    });

    // The server's own message is written for logs: the author gets a plain sentence instead.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The action could not be completed.");
    expect(alert).not.toHaveTextContent("The service is unavailable.");
    expect(screen.queryByRole("button", { name: "Save ADLs" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Bathing" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("combobox", { name: "Bathing" })).toHaveValue("limited_assist");
    expect(writes()).toEqual([]);
  });

  it("says a dropped connection on Save in words and keeps the entries", async () => {
    const user = userEvent.setup();
    mount((request) => (request.method === "GET" ? { json: null } : "drop"));
    await screen.findByRole("combobox", { name: "Bathing" });

    await user.selectOptions(levelOf("Bathing"), "Independent");
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The connection was interrupted. Your entries are still here; try again.",
    );
    expect(levelOf("Bathing")).toHaveValue("independent");
  });

  it("names the visit as unavailable on a 404 without saying why", async () => {
    mount(() => errorReply(404, "NOT_FOUND", "encounter not found"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That visit is no longer available to you.",
    );
  });

  it("has no accessibility violations once loaded", async () => {
    const { container } = mount(server(STORED));
    await screen.findByRole("combobox", { name: "Bathing" });

    const results = await axe.run(container);

    expect(results.violations).toEqual([]);
  });

  describe("what it tells the note it sits in", () => {
    it("is neither unsaved nor saving, and says a record is stored, when it opens on a recorded ADL", async () => {
      const onStatusChange = vi.fn();
      mount(server(STORED), { onStatusChange });
      await screen.findByRole("combobox", { name: "Bathing" });

      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith({
          dirty: false,
          saving: false,
          recorded: true,
        }),
      );
    });

    it("says nothing is stored, then unsaved once an answer changes, then stored once it is saved", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn();
      mount(server(null), { onStatusChange });
      await screen.findByRole("combobox", { name: "Bathing" });
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith({
          dirty: false,
          saving: false,
          recorded: false,
        }),
      );

      await user.selectOptions(levelOf("Bathing"), "Supervision");
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })),
      );

      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await screen.findByText("ADLs saved.");
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith({
          dirty: false,
          saving: false,
          recorded: true,
        }),
      );
      // The save was seen in flight on the way.
      expect(onStatusChange).toHaveBeenCalledWith(expect.objectContaining({ saving: true }));
    });

    it("is unsaved again when an answer is changed and changed back only to the saved one", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn();
      mount(server(STORED), { onStatusChange });
      await screen.findByRole("combobox", { name: "Bathing" });

      await user.selectOptions(levelOf("Bathing"), "Independent");
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })),
      );
      await user.selectOptions(levelOf("Bathing"), "Limited assist");
      await waitFor(() =>
        expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false })),
      );
    });

    it("says it is idle once it is gone, keeping the record it knew was stored", async () => {
      const onStatusChange = vi.fn();
      const { unmount } = mount(server(STORED), { onStatusChange });
      await screen.findByRole("combobox", { name: "Bathing" });

      unmount();

      expect(onStatusChange).toHaveBeenLastCalledWith({
        dirty: false,
        saving: false,
        recorded: true,
      });
    });
  });

  it("still tells the note a save landed when the panel went away while it was in flight", async () => {
    const onSaved = vi.fn();
    const { unmount } = mount(server(null), { onSaved });
    await screen.findByRole("combobox", { name: "Bathing" });

    fireEvent.click(screen.getByRole("button", { name: "Save ADLs" }));
    unmount();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  describe("the version it saves against", () => {
    it("sends the version it loaded as If-Match, then the version the save answered with", async () => {
      const user = userEvent.setup();
      const { writes } = mount(server(STORED));
      await screen.findByRole("combobox", { name: "Bathing" });

      await user.selectOptions(levelOf("Bathing"), "Supervision");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await screen.findByText("ADLs saved.");
      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await waitFor(() => expect(writes()).toHaveLength(2));

      expect(writes().map((write) => write.ifMatch)).toEqual([
        String(STORED_VERSION),
        String(STORED_VERSION + 1),
      ]);
    });

    it("says the record changed, keeps what was entered, and takes the current record only when asked", async () => {
      const user = userEvent.setup();
      const changed: AdlView = {
        ...STORED,
        version: STORED_VERSION + 5000,
        items: { bathing: "total_dependence" },
        devices: [],
      };
      let reads = 0;
      const { writes } = mount((request) => {
        if (request.method === "GET") {
          reads += 1;
          return { json: reads === 1 ? STORED : changed };
        }
        return errorReply(409, "STALE_VERSION", "stale");
      });
      await screen.findByRole("combobox", { name: "Bathing" });
      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));

      expect(await screen.findByText(/This record changed since you opened it\./)).toBeVisible();
      // The author's own entry is still there, and the save waits for their choice.
      expect(levelOf("Bathing")).toHaveValue("independent");
      expect(screen.getByRole("button", { name: "Save ADLs" })).toBeDisabled();
      expect(reads).toBe(1);

      await user.click(screen.getByRole("button", { name: "Reload the record" }));

      expect(await screen.findByRole("combobox", { name: "Bathing" })).toHaveValue(
        "total_dependence",
      );
      expect(screen.queryByText(/This record changed since you opened it\./)).toBeNull();
      expect(screen.getByRole("button", { name: "Save ADLs" })).toBeEnabled();
      // The next save is against the version just read.
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()[1]?.ifMatch).toBe(String(changed.version));
    });

    it("still counts what was entered as unsaved while it waits on the choice", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn();
      mount(
        server(STORED, () => errorReply(409, "STALE_VERSION", "stale")),
        { onStatusChange },
      );
      await screen.findByRole("combobox", { name: "Bathing" });
      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await screen.findByText(/This record changed since you opened it\./);

      expect(onStatusChange).toHaveBeenLastCalledWith({
        dirty: true,
        saving: false,
        recorded: true,
      });
    });
  });

  describe("a note that no longer takes the record", () => {
    it("says the note is finalized (409 NOTE_PINNED_AT_FINALIZE) and goes read-only", async () => {
      const user = userEvent.setup();
      mount(server(STORED, () => errorReply(409, "NOTE_PINNED_AT_FINALIZE", "pinned")));
      await screen.findByRole("combobox", { name: "Bathing" });

      await user.click(screen.getByRole("button", { name: "Save ADLs" }));

      expect(
        await screen.findByText(
          "This note is finalized, so these findings can no longer be changed.",
        ),
      ).toBeVisible();
      expect(levelOf("Bathing")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Save ADLs" })).toBeDisabled();
      expect(screen.queryByRole("button", { name: "Reload the record" })).toBeNull();
    });

    it("says the note has no section for the ADLs (422 FINDING_NOT_IN_NOTE) and goes read-only", async () => {
      const user = userEvent.setup();
      mount(server(STORED, () => errorReply(422, "FINDING_NOT_IN_NOTE", "no section")));
      await screen.findByRole("combobox", { name: "Bathing" });

      await user.click(screen.getByRole("button", { name: "Save ADLs" }));

      expect(
        await screen.findByText(
          "This visit's note has no section for these findings, so they cannot be recorded here.",
        ),
      ).toBeVisible();
      expect(levelOf("Bathing")).toBeDisabled();
      expect(screen.queryByText(/Choose one of the listed options/)).toBeNull();
    });
  });

  describe("choices the author has to make", () => {
    it("puts focus on Reload the record and announces the stale warning at once", async () => {
      const user = userEvent.setup();
      mount(server(STORED, () => errorReply(409, "STALE_VERSION", "stale")));
      await screen.findByRole("combobox", { name: "Bathing" });
      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));

      const reload = await screen.findByRole("button", { name: "Reload the record" });
      await waitFor(() => expect(reload).toHaveFocus());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This record changed since you opened it.",
      );
    });

    it("keeps focus in the panel when Try again replaces the failed load", async () => {
      const user = userEvent.setup();
      let reads = 0;
      mount((request) => {
        if (request.method !== "GET") return { json: {} };
        reads += 1;
        return reads === 1 ? errorReply(500, "INTERNAL", "down") : { json: STORED };
      });
      const retry = await screen.findByRole("button", { name: "Try again" });
      retry.focus();
      await user.click(retry);

      await screen.findByRole("combobox", { name: "Bathing" });
      await waitFor(() =>
        expect(screen.getByRole("region", { name: "Activities of daily living" })).toHaveFocus(),
      );
    });

    it("discards what was entered and goes back to the stored record", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn();
      mount(server(STORED), { onStatusChange });
      await screen.findByRole("combobox", { name: "Bathing" });
      expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();

      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("checkbox", { name: "Cane" }));
      await user.click(screen.getByRole("button", { name: "Discard changes" }));

      expect(levelOf("Bathing")).toHaveValue("limited_assist");
      expect(screen.getByRole("checkbox", { name: "Cane" })).not.toBeChecked();
      expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();
      expect(onStatusChange).toHaveBeenLastCalledWith({
        dirty: false,
        saving: false,
        recorded: true,
      });
    });

    it("discards back to what was last saved, not to what was first loaded", async () => {
      const user = userEvent.setup();
      mount(server(STORED));
      await screen.findByRole("combobox", { name: "Bathing" });
      await user.selectOptions(levelOf("Bathing"), "Supervision");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await screen.findByText("ADLs saved.");

      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("button", { name: "Discard changes" }));

      expect(levelOf("Bathing")).toHaveValue("supervision");
    });
  });

  describe("what a locked or reloading panel tells the note", () => {
    it("stops counting what was entered as unsaved once the note will not take it, and keeps it on screen read-only", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn();
      mount(
        server(STORED, () => errorReply(409, "NOTE_PINNED_AT_FINALIZE", "pinned")),
        {
          onStatusChange,
        },
      );
      await screen.findByRole("combobox", { name: "Bathing" });
      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await screen.findByText(
        "This note is finalized, so these findings can no longer be changed.",
      );

      expect(levelOf("Bathing")).toHaveValue("independent");
      expect(levelOf("Bathing")).toBeDisabled();
      expect(onStatusChange).toHaveBeenLastCalledWith({
        dirty: false,
        saving: false,
        recorded: true,
      });
    });

    it("keeps saying a record is stored while it is read again, so its section does not flip back to required", async () => {
      const user = userEvent.setup();
      const onStatusChange = vi.fn<(status: PanelStatus) => void>();
      mount(
        (request) =>
          request.method === "GET" ? { json: STORED } : errorReply(409, "STALE_VERSION", "stale"),
        { onStatusChange },
      );
      await screen.findByRole("combobox", { name: "Bathing" });
      await user.selectOptions(levelOf("Bathing"), "Independent");
      await user.click(screen.getByRole("button", { name: "Save ADLs" }));
      await user.click(await screen.findByRole("button", { name: "Reload the record" }));
      await screen.findByRole("combobox", { name: "Bathing" });

      const everSaidNotStored = onStatusChange.mock.calls.some(
        ([status]) => status.recorded === false,
      );
      expect(everSaidNotStored).toBe(false);
    });
  });

  it("names the field in words for a refusal it has no sentence for, and never shows the server's own message for an unmapped one", async () => {
    const user = userEvent.setup();
    mount(
      server(STORED, () =>
        errorReply(422, "VALIDATION_FAILED", "request validation failed", [
          { field: "someNewField", message: "must be shorter" },
        ]),
      ),
    );
    await screen.findByRole("combobox", { name: "Bathing" });
    await user.click(screen.getByRole("button", { name: "Save ADLs" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Some new field: must be shorter");
  });
});
