// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordCmsResultModal } from "../record-cms-result-modal";

// Group g3: the CMS-result dialog's "Report reference (optional)" field. The server accepts letters, digits, spaces and `. _ : # / -`
// up to 500 characters (REFERENCE_CHARSET in hope-typebox.ts) and screens the rest for patient identifiers, so the dialog says so
// beside the field, refuses a character the server would refuse before anything is confirmed, and answers a server refusal on the
// field (its words name the wire field `reportReference` and, for the charset, say only "Expected union value").

afterEach(cleanup);

type Reply = { data?: unknown; error?: unknown; response?: Response };
const ITEM = { assessmentId: "a-1", label: "Lovelace, Ada — Admission" };
const REFERENCE_WORDS =
  "That reference has a character that is not allowed. Use only letters, digits, spaces and . _ : # / -, up to 500 characters.";
const PHI_WORDS =
  "This looks like it contains a Social Security or Medicare number. Enter the reference CMS gave for the report, never a patient's number.";

const phiRefusal = (): Reply => ({
  data: undefined,
  error: {
    error: {
      code: "EVIDENCE_LOOKS_LIKE_PHI",
      message:
        "reportReference looks like it contains a patient identifier (a Social Security or Medicare number). Enter the reference that CMS or the iQIES upload gave, never a patient's number.",
    },
  },
  response: new Response(null, { status: 422 }),
});
const charsetRefusal = (): Reply => ({
  data: undefined,
  error: {
    error: {
      code: "VALIDATION_FAILED",
      message: "request validation failed",
      details: [{ field: "reportReference", code: "INVALID", message: "Expected union value" }],
    },
  },
  response: new Response(null, { status: 422 }),
});

function mount(post: () => Promise<Reply>) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onConflict = vi.fn();
  const POST = vi.fn(post);
  render(
    <ApiClientProvider client={{ GET: vi.fn(), POST } as unknown as ApiClient}>
      <RecordCmsResultModal
        open
        submissionId="sub-1"
        items={[ITEM]}
        onClose={onClose}
        onDone={onDone}
        onConflict={onConflict}
      />
    </ApiClientProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Record CMS result" });
  fireEvent.change(within(dialog).getByLabelText(`Outcome for ${ITEM.label}, row 1`), {
    target: { value: "accepted" },
  });
  const field = () => within(dialog).getByLabelText(/Report reference/) as HTMLInputElement;
  const review = () =>
    within(dialog).getByRole("button", { name: "Review and record" }) as HTMLButtonElement;
  return { dialog, field, review, POST, onClose, onDone, onConflict };
}

function typeReference(field: HTMLInputElement, value: string): void {
  fireEvent.change(field, { target: { value } });
}

async function reviewAndConfirm(dialog: HTMLElement): Promise<void> {
  fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
}

describe("the report reference field", () => {
  it("says which characters it takes and how many", () => {
    const { dialog, field } = mount(async () => ({}));

    const hint = within(dialog).getByText(/Letters, digits, spaces and/);
    expect(hint.textContent).toBe(
      "Letters, digits, spaces and . _ : # / - only, up to 500 characters.",
    );
    expect(field().getAttribute("maxlength")).toBe("500");
    expect(field().getAttribute("aria-describedby")).toContain(hint.id);
  });

  it("accepts what the server accepts", () => {
    const { dialog, field, review } = mount(async () => ({}));

    typeReference(field(), "iQIES ref #A-12_3.4:5/6");

    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(review().disabled).toBe(false);
  });

  it.each([
    ["markup", "<b>ref</b>"],
    ["a quote", `ref "1"`],
    ["an accented letter", "réf-1"],
    ["a zero-width space", "ref\u200b1"],
    ["a comma", "ref,1"],
  ])("refuses %s before anything is confirmed, with a static sentence", (_n, value) => {
    const { dialog, field, review, POST } = mount(async () => ({}));

    typeReference(field(), value);

    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((a) => a.textContent),
    ).toEqual([REFERENCE_WORDS]);
    expect(dialog.textContent).not.toContain(value);
    expect(review().disabled).toBe(true);
    fireEvent.click(review());
    expect(POST).not.toHaveBeenCalled();
  });

  it("lets Review and record through again once the reference is fixed or cleared", () => {
    const { field, review } = mount(async () => ({}));
    typeReference(field(), "bad<ref>");
    expect(review().disabled).toBe(true);

    typeReference(field(), "good ref");
    expect(review().disabled).toBe(false);

    typeReference(field(), "bad<ref>");
    typeReference(field(), "");
    expect(review().disabled).toBe(false);
  });
});

describe.each([
  [
    "a charset refusal (422 VALIDATION_FAILED naming reportReference)",
    charsetRefusal,
    REFERENCE_WORDS,
  ],
  ["the patient-identifier refusal (422 EVIDENCE_LOOKS_LIKE_PHI)", phiRefusal, PHI_WORDS],
])("%s", (_name, refusal, words) => {
  it("is answered on the field with focus, keeps what was entered, and does not re-read the page", async () => {
    const { dialog, field, review, onClose, onDone, onConflict } = mount(async () => refusal());
    typeReference(field(), "REF 123");

    await reviewAndConfirm(dialog);

    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((a) => a.textContent),
    ).toEqual([words]);
    expect(field().getAttribute("aria-describedby")).toContain(
      within(dialog).getByRole("alert").id,
    );
    expect(document.activeElement).toBe(field());
    // The server's words, which name the wire field, are not shown; the entry is kept, and nothing was recorded.
    expect(dialog.textContent).not.toContain("reportReference");
    expect(dialog.textContent).not.toContain("Expected union value");
    expect(field().value).toBe("REF 123");
    expect(
      (within(dialog).getByLabelText(`Outcome for ${ITEM.label}, row 1`) as HTMLSelectElement)
        .value,
    ).toBe("accepted");
    expect(review().disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("clears as soon as the reference is edited", async () => {
    const { dialog, field } = mount(async () => refusal());
    typeReference(field(), "REF 123");
    await reviewAndConfirm(dialog);
    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));

    typeReference(field(), "REF 1234");

    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("is said again when the same reference is sent again and refused again", async () => {
    const { dialog, field, POST } = mount(async () => refusal());
    typeReference(field(), "REF 123");
    await reviewAndConfirm(dialog);
    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));

    await reviewAndConfirm(dialog);

    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).getAllByRole("alert")).toHaveLength(1));
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
  });
});

describe("another refusal of the result", () => {
  it("is the server's words in the alert, with the field untouched", async () => {
    const { dialog, field } = mount(async () => ({
      data: undefined,
      error: { error: { code: "M10_RESULT_INVALID", message: "server words for that" } },
      response: new Response(null, { status: 422 }),
    }));
    typeReference(field(), "REF 123");

    await reviewAndConfirm(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toBe("server words for that");
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });

  it("is also the server's words for a validation refusal about another field", async () => {
    const { dialog, field } = mount(async () => ({
      data: undefined,
      error: {
        error: {
          code: "VALIDATION_FAILED",
          message: "request validation failed",
          details: [{ field: "results.0.message", code: "INVALID", message: "too long" }],
        },
      },
      response: new Response(null, { status: 422 }),
    }));
    typeReference(field(), "REF 123");

    await reviewAndConfirm(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "request validation failed",
    );
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });
});
