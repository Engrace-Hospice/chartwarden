// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeRecordModal } from "../hope-record-modal";
import { SESSION, ok } from "./workspace-test-kit";

// Group g1 (web-k18, web-k17): the record dialog's words for a capture nobody confirmed say "check the timeline before trying again", so
// the page behind it is read again (`onOutcomeUnknown`) for a rejected request, a timeout, an empty 5xx and a server fault, and never
// for a refusal (4xx), a busy record (409 M10_RECORD_BUSY: not applied) or a success. And what a clinician who cannot override is told
// to do is only what is certain: to ask their administrator how the visit should be recorded, not to send someone who may be refused.

afterEach(cleanup);

const refusal = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: `server words for ${code}` } },
  response: new Response(null, { status }),
});
const empty = (status: number) => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});

type Mocked = ReturnType<typeof vi.fn>;
function mount(
  post: Mocked,
  callbacks: { onOutcomeUnknown?: () => void; session?: unknown; window?: unknown } = {},
) {
  const onDone = vi.fn();
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <SessionProvider session={(callbacks.session ?? SESSION) as typeof SESSION}>
      <ApiClientProvider client={client}>
        <HopeRecordModal
          open
          admissionId="adm-1"
          window={(callbacks.window ?? null) as never}
          onClose={vi.fn()}
          onDone={onDone}
          onOutcomeUnknown={callbacks.onOutcomeUnknown}
        />
      </ApiClientProvider>
    </SessionProvider>,
  );
  const dialog = screen.getByRole("dialog", { name: "Record HOPE timepoint" });
  const record = () =>
    within(dialog).getByRole("button", { name: "Record draft" }) as HTMLButtonElement;
  return { dialog, record, onDone };
}

describe("a capture whose outcome is not known", () => {
  it.each([
    ["is rejected", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["answers 502 with no body", async () => empty(502)],
    ["answers 500 with a body of the server's own", async () => refusal(500, "INTERNAL")],
  ])(
    "tells the page behind to re-read when the request %s, and frees the dialog",
    async (_n, answer) => {
      const onOutcomeUnknown = vi.fn();
      const { dialog, record } = mount(vi.fn(answer), { onOutcomeUnknown });

      fireEvent.click(record());

      await within(dialog).findByRole("alert");
      expect(onOutcomeUnknown).toHaveBeenCalledTimes(1);
      expect(record().disabled).toBe(false);
    },
  );

  it("is reported, not swallowed, when the page's callback throws (the dialog is still freed)", async () => {
    const reported = vi.fn();
    const original = globalThis.reportError;
    globalThis.reportError = reported;
    try {
      const { dialog, record } = mount(
        vi.fn(() => Promise.reject(new TypeError("offline"))),
        {
          onOutcomeUnknown: () => {
            throw new Error("reload exploded");
          },
        },
      );

      fireEvent.click(record());

      await within(dialog).findByRole("alert");
      expect(reported).toHaveBeenCalledTimes(1);
      expect(record().disabled).toBe(false);
    } finally {
      globalThis.reportError = original;
    }
  });

  it("works without the callback", async () => {
    const { dialog, record } = mount(vi.fn(async () => empty(502)));

    fireEvent.click(record());

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "could not be confirmed",
    );
  });
});

describe("a capture whose outcome is known", () => {
  it.each([
    ["a 422 refusal", refusal(422, "VALIDATION_FAILED")],
    ["a 403 refusal", refusal(403, "FORBIDDEN")],
    ["a 409 M10_RECORD_BUSY (the step was not applied)", refusal(409, "M10_RECORD_BUSY")],
    ["a 4xx with no body", empty(403)],
  ])("does not re-read the page behind after %s", async (_name, answer) => {
    const onOutcomeUnknown = vi.fn();
    const { dialog, record } = mount(
      vi.fn(async () => answer),
      { onOutcomeUnknown },
    );

    fireEvent.click(record());

    await within(dialog).findByRole("alert");
    expect(onOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("does not re-read the page behind after a success (onDone is what refreshes it)", async () => {
    const onOutcomeUnknown = vi.fn();
    const draft = { id: "hope-9" }; // no date back: not evidence of an existing draft
    const { record, onDone } = mount(
      vi.fn(async () => ok(draft)),
      { onOutcomeUnknown },
    );

    fireEvent.click(record());

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(onOutcomeUnknown).not.toHaveBeenCalled();
  });
});

describe("what a clinician who cannot override is told (web-k17)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const expired = () => {
    const now = Date.now();
    return {
      id: "schedule-7",
      rfaKind: "02_huv1",
      windowOpensAt: new Date(now - 30 * DAY).toISOString(),
      windowClosesAt: new Date(now - 20 * DAY).toISOString(),
      lateDeadlineAt: new Date(now - 10 * DAY).toISOString(),
    };
  };
  const NO_OVERRIDE = { ...SESSION, permissions: ["hope.timepoint.write"] };

  it("points at the administrator to ask how to record the visit, not at someone to record it", () => {
    const { dialog } = mount(vi.fn(), { session: NO_OVERRIDE, window: expired() });

    const words =
      within(dialog).getByText(/administrator with override permission/).textContent ?? "";

    expect(words).toContain("Ask your administrator how this visit should be recorded");
    expect(words).not.toMatch(/ask one to record/i);
  });

  it("says the same after a refusal of an expired visit the modal judged in time", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"));
    const { dialog, record } = mount(post, { session: NO_OVERRIDE });

    fireEvent.click(record());

    const alert = (await within(dialog).findByRole("alert")).textContent ?? "";
    expect(alert).toMatch(/ask your administrator how this visit should be recorded/i);
    expect(alert).not.toMatch(/ask one to record/i);
  });
});
