// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeRecordModal } from "../hope-record-modal";
import { SESSION, ok } from "./workspace-test-kit";

// Group g3: an override justification the server refuses as looking like a patient identifier (422 EVIDENCE_LOOKS_LIKE_PHI) is
// answered on the field, in words that fit an override reason: the server's own words talk of "what was checked", cite "documents"
// and name the wire field `adminOverrideJustification`, none of which a clinician can act on. The dialog stays open, the text is kept
// (nothing was recorded), and the refusal is not an unknown outcome.

afterEach(cleanup);

const OVERRIDE_SESSION = { ...SESSION, permissions: ["hope.admin.late_deadline_override"] };
const EXPIRED_WINDOW = {
  id: "schedule-9",
  rfaKind: "02_huv1",
  windowOpensAt: "2000-01-01T00:00:00.000Z",
  windowClosesAt: "2000-01-10T00:00:00.000Z",
  lateDeadlineAt: "2000-01-20T00:00:00.000Z",
};
const SERVER_WORDS =
  "adminOverrideJustification looks like it contains a patient identifier (a Social Security or Medicare number). Describe what was checked without naming a patient, and cite documents by their title or a ticket number.";
const FIELD_WORDS =
  "This looks like it contains a Social Security or Medicare number. Say why this record is being entered after the late deadline, without naming a patient or quoting an identifier. A long ID number can trip this check, so leave it out.";
const INVISIBLE_WORDS =
  "Contains invisible or formatting characters, often from pasted text. Retype the text instead of pasting it.";
const NOT_ACCEPTED_WORDS =
  "The justification was not accepted. Check that it is between 20 and 1000 characters of plain text, then record again.";
const JUSTIFICATION = "The visit was completed on time; the entry was delayed by an outage.";

const phiRefusal = () => ({
  data: undefined,
  error: { error: { code: "EVIDENCE_LOOKS_LIKE_PHI", message: SERVER_WORDS } },
  response: new Response(null, { status: 422 }),
});

type Mocked = ReturnType<typeof vi.fn>;
function mount(post: Mocked) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onOutcomeUnknown = vi.fn();
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <SessionProvider session={OVERRIDE_SESSION}>
      <ApiClientProvider client={client}>
        <HopeRecordModal
          open
          admissionId="adm-1"
          window={EXPIRED_WINDOW}
          onClose={onClose}
          onDone={onDone}
          onOutcomeUnknown={onOutcomeUnknown}
        />
      </ApiClientProvider>
    </SessionProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Record HOPE timepoint" });
  fireEvent.click(
    within(dialog).getByRole("checkbox", { name: "Record with administrative override" }),
  );
  const field = () =>
    within(dialog).getByRole("textbox", {
      name: /Justification for the override/,
    }) as HTMLTextAreaElement;
  fireEvent.change(field(), { target: { value: JUSTIFICATION } });
  const record = () =>
    within(dialog).getByRole("button", { name: "Record draft" }) as HTMLButtonElement;
  return { dialog, field, record, onClose, onDone, onOutcomeUnknown };
}

describe("an override justification refused as looking like a patient identifier", () => {
  it("answers on the field in the override's own words, keeps the dialog and the text, and is not an unknown outcome", async () => {
    const post = vi.fn(async () => phiRefusal());
    const { dialog, field, record, onClose, onDone, onOutcomeUnknown } = mount(post);

    fireEvent.click(record());

    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    const alerts = within(dialog).getAllByRole("alert");
    expect(alerts.map((a) => a.textContent)).toEqual([FIELD_WORDS]);
    // The error is tied to the textarea (and so is read with it), and it is the field that keeps keyboard focus.
    expect(field().getAttribute("aria-describedby")).toContain(alerts[0]?.id);
    expect(document.activeElement).toBe(field());
    // The server's evidence-oriented words, and the wire field they name, are not shown.
    expect(dialog.textContent).not.toContain("adminOverrideJustification");
    expect(dialog.textContent).not.toContain("what was checked");
    // Nothing was recorded: the dialog stays, the text stays, and the page behind is not told to re-read.
    expect(field().value).toBe(JUSTIFICATION);
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(onOutcomeUnknown).not.toHaveBeenCalled();
    expect(record().disabled).toBe(false);
  });

  it("clears the field error as soon as the clinician edits the text", async () => {
    const { dialog, field, record } = mount(vi.fn(async () => phiRefusal()));
    fireEvent.click(record());
    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));

    fireEvent.change(field(), { target: { value: `${JUSTIFICATION} It was an outage.` } });

    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("says it again when the same text is sent again and is refused again", async () => {
    const post = vi.fn(async () => phiRefusal());
    const { dialog, field, record } = mount(post);
    fireEvent.click(record());
    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));

    fireEvent.click(record());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).getAllByRole("alert")).toHaveLength(1));
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });

  it("leaves another refusal as the server's own words", async () => {
    const post = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "M10_ADMISSION_NOT_ACTIVE", message: "server words for that" } },
      response: new Response(null, { status: 409 }),
    }));
    const { dialog, field, record } = mount(post);

    fireEvent.click(record());

    expect((await within(dialog).findByRole("alert")).textContent).toBe("server words for that");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });
});

/** The envelope the server answers a failed validation with (`ValidationError`: code VALIDATION_FAILED, the detail names the field). */
const validationRefusal = (field: string, code: string, message: string) => ({
  data: undefined,
  error: {
    error: {
      code: "VALIDATION_FAILED",
      message: "an admin deadline override needs a plain-text justification",
      details: [{ field, code, message }],
    },
  },
  response: new Response(null, { status: 422 }),
});
const SERVER_INVISIBLE =
  "adminOverrideJustification must not contain control, zero-width or other formatting characters";

// What the server refuses as control, zero-width or other formatting characters (`FORBIDDEN_JUSTIFICATION_CHARACTER`) the dialog refuses
// first: a pasted zero-width space passes the length minimum, and the 422 would name the wire field in the bottom alert.
describe("an override justification with invisible or formatting characters", () => {
  it.each([
    ["a zero-width space", "\u200b"],
    ["a left-to-right mark", "\u200e"],
    ["a soft hyphen", "\u00ad"],
    ["a byte-order mark inside the text", "\ufeff"],
    ["a NUL", "\u0000"],
    ["a lone surrogate", "\ud800"],
  ])("is refused on the field, with a static sentence, before anything is sent (%s)", (_n, bad) => {
    const post = vi.fn(async () => ok({ id: "created" }));
    const { dialog, field, record } = mount(post);

    fireEvent.change(field(), {
      target: { value: `The visit was done${bad} on time; an outage.` },
    });

    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((a) => a.textContent),
    ).toEqual([INVISIBLE_WORDS]);
    expect(record().disabled).toBe(true);
    fireEvent.click(record());
    expect(post).not.toHaveBeenCalled();
  });

  it("is sent again once the character is gone, and still allows a line break and a tab", async () => {
    const post = vi.fn(async () => ok({ id: "created" }));
    const { field, record } = mount(post);
    fireEvent.change(field(), {
      target: { value: `The visit was done\u200b on time; an outage.` },
    });
    expect(record().disabled).toBe(true);

    fireEvent.change(field(), { target: { value: "The visit was done on time;\n\tan outage." } });

    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(record().disabled).toBe(false);
    fireEvent.click(record());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  it("is answered on the field, in the same words and with focus, when the server still refuses it (INVALID_CHARACTERS)", async () => {
    const post = vi.fn(async () =>
      validationRefusal("adminOverrideJustification", "INVALID_CHARACTERS", SERVER_INVISIBLE),
    );
    const { dialog, field, record, onClose, onOutcomeUnknown } = mount(post);

    fireEvent.click(record());

    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((a) => a.textContent),
    ).toEqual([INVISIBLE_WORDS]);
    expect(field().getAttribute("aria-describedby")).toContain(
      within(dialog).getByRole("alert").id,
    );
    expect(document.activeElement).toBe(field());
    expect(dialog.textContent).not.toContain("adminOverrideJustification");
    expect(dialog.textContent).not.toContain("zero-width");
    expect(field().value).toBe(JUSTIFICATION);
    expect(onClose).not.toHaveBeenCalled();
    expect(onOutcomeUnknown).not.toHaveBeenCalled();

    fireEvent.change(field(), { target: { value: `${JUSTIFICATION} Again.` } });
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("is answered on the field in its own words when the server objects to the justification for another reason", async () => {
    const post = vi.fn(async () =>
      validationRefusal(
        "adminOverrideJustification",
        "INVALID",
        "Expected string length greater or equal to 20",
      ),
    );
    const { dialog, field, record } = mount(post);

    fireEvent.click(record());

    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((a) => a.textContent),
    ).toEqual([NOT_ACCEPTED_WORDS]);
    expect(dialog.textContent).not.toContain("Expected string length");
    expect(document.activeElement).toBe(field());
  });

  it("leaves a validation refusal about another field as the server's words in the alert", async () => {
    const post = vi.fn(async () =>
      validationRefusal("targetDate", "INVALID", "Expected string to match 'date-time' format"),
    );
    const { dialog, field, record } = mount(post);

    fireEvent.click(record());

    expect((await within(dialog).findByRole("alert")).textContent).toContain("targetDate");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });
});

describe("the override justification's hint", () => {
  it("states both bounds, that the text cannot be changed later, and what must not be typed", () => {
    const { dialog, field } = mount(vi.fn(async () => ok({ id: "created" })));

    const hint = within(dialog).getByText(/Between 20 and 1000 characters/);
    expect(hint.textContent).toContain("cannot be changed later");
    expect(hint.textContent).toMatch(/do not enter a patient's name or a Social Security/i);
    expect(field().getAttribute("maxlength")).toBe("1000");
  });
});
