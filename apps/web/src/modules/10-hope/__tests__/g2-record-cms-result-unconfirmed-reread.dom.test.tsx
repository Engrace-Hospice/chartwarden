// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordCmsResultModal } from "../record-cms-result-modal";

// Group g2: the CMS-result write that got no usable answer. The dialog's words say to check the record (the result may have
// landed), so the page behind it must be re-read, as it already is for a rejected request. A refusal that is definite (a 422,
// a busy record) leaves the page alone.

afterEach(cleanup);

type Reply = { data?: unknown; error?: unknown; response?: Response };
const empty = (status: number): Reply => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});
const refusal = (status: number, code: string): Reply => ({
  data: undefined,
  error: { error: { code, message: `server words for ${code}` } },
  response: new Response(null, { status }),
});

function submitResult(post: () => Promise<Reply>, onConflict: () => void) {
  render(
    <ApiClientProvider client={{ GET: vi.fn(), POST: vi.fn(post) } as unknown as ApiClient}>
      <RecordCmsResultModal
        open
        submissionId="sub-1"
        items={[{ assessmentId: "a-1", label: "Lovelace, Ada — Admission" }]}
        onClose={vi.fn()}
        onDone={vi.fn()}
        onConflict={onConflict}
      />
    </ApiClientProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Record CMS result" });
  fireEvent.change(within(dialog).getByLabelText("Outcome for Lovelace, Ada — Admission, row 1"), {
    target: { value: "accepted" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Review and record" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm and record" }));
  return dialog;
}

/** Lets a re-read that was (wrongly) not asked for show up as a late call. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the CMS result dialog: a write whose outcome is unknown re-reads the page", () => {
  it.each([
    ["an empty 502", async () => empty(502)],
    ["an empty 503", async () => empty(503)],
    ["an empty 504", async () => empty(504)],
    ["a 500 with a server fault", async () => refusal(500, "INTERNAL")],
    [
      "a rejected request",
      async (): Promise<Reply> => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("asks the page to re-read after %s", async (_name, post) => {
    const onConflict = vi.fn();

    const dialog = submitResult(post, onConflict);

    await within(dialog).findByRole("alert");
    await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["a 422 refusal", async () => refusal(422, "M10_RESULT_INVALID")],
    ["a 403 refusal", async () => refusal(403, "FORBIDDEN")],
    ["an empty 403", async () => empty(403)],
    ["a busy record (409 M10_RECORD_BUSY)", async () => refusal(409, "M10_RECORD_BUSY")],
    ["a degraded dependency (503 DEGRADED)", async () => refusal(503, "DEGRADED")],
  ])("does not ask the page to re-read after %s", async (_name, post) => {
    const onConflict = vi.fn();

    const dialog = submitResult(post, onConflict);

    await within(dialog).findByRole("alert");
    await settle();
    expect(onConflict).not.toHaveBeenCalled();
  });

  it("still asks the page to re-read for a 409 that is not a busy record", async () => {
    const onConflict = vi.fn();

    const dialog = submitResult(
      async () => refusal(409, "M10_RESULT_ALREADY_RECORDED"),
      onConflict,
    );

    await within(dialog).findByRole("alert");
    await waitFor(() => expect(onConflict).toHaveBeenCalledTimes(1));
  });
});
