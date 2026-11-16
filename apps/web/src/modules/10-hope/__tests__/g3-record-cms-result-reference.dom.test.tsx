// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordCmsResultModal } from "../record-cms-result-modal";

// Group g3: the CMS-result dialog's "Report reference (optional)" field. The server accepts letters, digits, spaces and `. _ : # / -`
// up to 128 characters, the first one not a space (HOPE_TOKEN_PATTERN in hope-typebox.ts) and screens the rest for patient identifiers, so the dialog says so
// beside the field, refuses a character the server would refuse before anything is confirmed, and answers a server refusal on the
// field (its words name the wire field `reportReference` and, for the charset, say only "Expected union value").

afterEach(cleanup);

type Reply = { data?: unknown; error?: unknown; response?: Response };
const ITEM = { assessmentId: "a-1", label: "Lovelace, Ada — Admission" };
const REFERENCE_WORDS =
  "That reference has a character that is not allowed. Use only letters, digits, spaces and . _ : # / -, up to 128 characters.";
const PHI_WORDS =
  "This looks like it contains a Social Security or Medicare number. Enter the reference CMS gave for the report, never a patient's number.";

const phiRefusal = (): Reply => ({
  data: undefined,
  error: {
    error: {
      code: "EVIDENCE_LOOKS_LIKE_PHI",
      message:
        "reportReference looks like it contains a patient identifier (a Social Security or Medicare number). Enter the reference that CMS or the iQIES upload gave, never a patient's number.",
      details: [
        {
          field: "reportReference",
          code: "EVIDENCE_LOOKS_LIKE_PHI",
          message: "reportReference ...",
        },
      ],
    },
  },
  response: new Response(null, { status: 422 }),
});
/** The same code for a result ROW's token (`results.<i>.<token>`): the route screens those too, and names the token in its words. */
const ROW_PHI_WORDS =
  "A result row's code looks like it contains a patient identifier (a Social Security or Medicare number). Enter the code or id that CMS gave, never a patient's number.";
const rowPhiRefusal = (): Reply => ({
  data: undefined,
  error: {
    error: {
      code: "EVIDENCE_LOOKS_LIKE_PHI",
      message: ROW_PHI_WORDS,
      details: [
        { field: "results.0.code", code: "EVIDENCE_LOOKS_LIKE_PHI", message: ROW_PHI_WORDS },
      ],
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
      "Letters, digits, spaces and . _ : # / - only, up to 128 characters.",
    );
    expect(field().getAttribute("maxlength")).toBe("128");
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

  it("blocks a reference longer than the server takes (128 characters), and takes exactly 128", () => {
    const { dialog, field, review, POST } = mount(async () => ({}));

    typeReference(field(), "a".repeat(129));

    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(
      within(dialog)
        .getAllByRole("alert")
        .map((a) => a.textContent),
    ).toEqual([REFERENCE_WORDS]);
    expect(review().disabled).toBe(true);
    fireEvent.click(review());
    expect(POST).not.toHaveBeenCalled();

    typeReference(field(), "a".repeat(128));

    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(review().disabled).toBe(false);
  });

  it("measures the reference trimmed: surrounding spaces are neither refused nor sent, and spaces alone are no reference", async () => {
    const { dialog, field, review, POST } = mount(async () => ({ data: { ok: true } }));

    // The server refuses a value that starts with a space, so the dialog trims first; nothing but spaces is left as no reference.
    typeReference(field(), "   ");
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(review().disabled).toBe(false);
    await reviewAndConfirm(dialog);
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [, init] = POST.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body).not.toHaveProperty("reportReference");
  });

  it("sends the reference without its surrounding spaces", async () => {
    const { dialog, field, POST } = mount(async () => ({ data: { ok: true } }));
    typeReference(field(), "  REF 1  ");
    expect(field().getAttribute("aria-invalid")).toBeNull();

    await reviewAndConfirm(dialog);

    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [, init] = POST.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body.reportReference).toBe("REF 1");
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

  it("is answered on the field again, with focus, when the same reference is sent again and refused again", async () => {
    let answer: (reply: Reply) => void = () => undefined;
    const replies: Array<() => Promise<Reply>> = [
      async () => refusal(),
      () =>
        new Promise<Reply>((resolve) => {
          answer = resolve;
        }),
    ];
    const { dialog, field, POST } = mount(() => (replies.shift() as () => Promise<Reply>)());
    typeReference(field(), "REF 123");
    await reviewAndConfirm(dialog);
    await waitFor(() => expect(field().getAttribute("aria-invalid")).toBe("true"));
    const firstAlert = within(dialog).getByRole("alert");

    await reviewAndConfirm(dialog);

    // While the second request is out the form is not on screen: no stale refusal is shown beside the confirmation.
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    expect(within(dialog).queryByLabelText(/Report reference/)).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    answer(refusal());
    await waitFor(() => expect(within(dialog).getAllByRole("alert")).toHaveLength(1));
    // The refusal is announced afresh (a new alert on the re-mounted field), and focus is on that field again.
    expect(within(dialog).getByRole("alert")).not.toBe(firstAlert);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(field());
  });
});

describe("a patient-identifier refusal of a result row's token", () => {
  it("is not put on the report reference: the field stays valid and the server's words, which name the token, are shown", async () => {
    const { dialog, field, review, onConflict } = mount(async () => rowPhiRefusal());
    typeReference(field(), "REF 123");

    await reviewAndConfirm(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toBe(ROW_PHI_WORDS);
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1);
    expect(field().getAttribute("aria-invalid")).toBeNull();
    expect(dialog.textContent).not.toContain("Enter the reference CMS gave");
    // Back on the form with everything kept, and nothing moved focus to the reference.
    expect(field().value).toBe("REF 123");
    expect(review().disabled).toBe(false);
    expect(document.activeElement).not.toBe(field());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("is the server's words too when the refusal names no field at all", async () => {
    const { dialog, field } = mount(async () => ({
      data: undefined,
      error: { error: { code: "EVIDENCE_LOOKS_LIKE_PHI", message: ROW_PHI_WORDS } },
      response: new Response(null, { status: 422 }),
    }));
    typeReference(field(), "REF 123");

    await reviewAndConfirm(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toBe(ROW_PHI_WORDS);
    expect(field().getAttribute("aria-invalid")).toBeNull();
  });
});

// The server takes a row's `code` and `itemCode` in the same charset as the reference (empty allowed, 64 characters:
// HOPE_RESULT_TOKEN_PATTERN), and the dialog says so before the Review step instead of sending what is refused.
describe.each([["CMS code"], ["Item"]])("the %s of a result row", (label) => {
  const TOKEN_WORDS =
    "A code or item has a character that is not allowed. Use only letters, digits, spaces and . _ : # / -, up to 64 characters.";
  const tokenField = (dialog: HTMLElement) =>
    within(dialog).getByLabelText(`${label} for ${ITEM.label}, row 1`) as HTMLInputElement;
  const typeToken = (dialog: HTMLElement, value: string) =>
    fireEvent.change(tokenField(dialog), { target: { value } });

  it.each([
    ["markup", "<b>x</b>"],
    ["a comma", "E,12"],
    ["a quote", 'E"1'],
    ["an accented letter", "réf"],
    ["a zero-width space", "E\u200b1"],
    ["more than 64 characters", "a".repeat(65)],
  ])("refuses %s with a static sentence, marks the field, and blocks the review", (_n, value) => {
    const { dialog, review, POST } = mount(async () => ({}));

    typeToken(dialog, value);

    expect(tokenField(dialog).getAttribute("aria-invalid")).toBe("true");
    const alert = within(dialog).getByRole("alert");
    expect(alert.textContent).toBe(TOKEN_WORDS);
    expect(tokenField(dialog).getAttribute("aria-describedby")).toContain(alert.id);
    expect(review().disabled).toBe(true);
    fireEvent.click(review());
    expect(POST).not.toHaveBeenCalled();
  });

  it.each([
    ["a code", "E-123 a.b_c:d#e/f"],
    ["exactly 64 characters", "a".repeat(64)],
    ["nothing", ""],
    ["spaces only (no value once trimmed)", "   "],
    ["a value with surrounding spaces", "  X1  "],
  ])("takes %s", (_n, value) => {
    const { dialog, review } = mount(async () => ({}));

    typeToken(dialog, value);

    expect(tokenField(dialog).getAttribute("aria-invalid")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(review().disabled).toBe(false);
  });

  it("lets the review through again once the value is fixed", () => {
    const { dialog, review } = mount(async () => ({}));
    typeToken(dialog, "bad<code>");
    expect(review().disabled).toBe(true);

    typeToken(dialog, "good-code");

    expect(tokenField(dialog).getAttribute("aria-invalid")).toBeNull();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(review().disabled).toBe(false);
  });
});

it("checks a pasted report's codes the same way: an import that fills a refused value blocks the review", () => {
  const { dialog, review } = mount(async () => ({}));
  const report = JSON.stringify([
    { assessmentId: ITEM.assessmentId, status: "rejected", code: "E<1>", itemCode: "J2030" },
  ]);

  fireEvent.change(within(dialog).getByLabelText(/Paste CMS report/), {
    target: { value: report },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Import pasted report" }));

  expect(
    (
      within(dialog).getByLabelText(`CMS code for ${ITEM.label}, row 1`) as HTMLInputElement
    ).getAttribute("aria-invalid"),
  ).toBe("true");
  expect(review().disabled).toBe(true);
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
