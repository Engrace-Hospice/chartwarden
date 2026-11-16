// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeRecordModal } from "../hope-record-modal";
import { SESSION, ok } from "./workspace-test-kit";

// A holder of the override permission: the server refuses `adminOverride` (403) from anyone else, so the modal offers the control only to
// a session that is not known to lack it (g1-record-override-permission.dom.test.tsx).
const OVERRIDE_SESSION = { ...SESSION, permissions: ["hope.admin.late_deadline_override"] };

// Group g1: what the server's window refusal asks for is offered whenever it is STRICTER than the modal's own verdict (a client clock
// behind the server, or a stored window that has since moved); the explanation of an added control goes when the control does; and the
// visit date the modal opens with is said to be a default until the clinician edits it.

afterEach(cleanup);

type Mocked = ReturnType<typeof vi.fn>;
type Sent = { body: Record<string, unknown> };
const bodyOf = (post: Mocked, call: number): Record<string, unknown> =>
  (post.mock.calls[call] as unknown as [string, Sent])[1].body;
const refusal = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: `server words for ${code}` } },
  response: new Response(null, { status }),
});

const DAY = 24 * 60 * 60 * 1000;
const windowAt = (opens: number, closes: number, late: number) => {
  const now = Date.now();
  return {
    id: "schedule-7",
    rfaKind: "02_huv1",
    windowOpensAt: new Date(now + opens * DAY).toISOString(),
    windowClosesAt: new Date(now + closes * DAY).toISOString(),
    lateDeadlineAt: new Date(now + late * DAY).toISOString(),
  };
};
/** Closed 3 days ago, late deadline in 10 days: the modal judges a capture now as late. */
const LATE_WINDOW = () => windowAt(-10, -3, 10);
/** Late deadline passed long ago: the modal judges a capture now as past it. */
const EXPIRED_WINDOW = () => windowAt(-30, -20, -10);
/** Opens in ten days: the modal judges a capture now as before the window. */
const FUTURE_WINDOW = () => windowAt(10, 20, 30);

function mount(post: Mocked, window: ReturnType<typeof windowAt> | null = null) {
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <SessionProvider session={OVERRIDE_SESSION}>
      <ApiClientProvider client={client}>
        <HopeRecordModal
          open
          admissionId="adm-1"
          window={window}
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </ApiClientProvider>
    </SessionProvider>,
  );
  return screen.getByRole("dialog", { name: "Record HOPE timepoint" });
}
const record = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Record draft" }) as HTMLButtonElement;
const overrideBox = (dialog: HTMLElement) =>
  within(dialog).queryByRole("checkbox", { name: /administrative override/ });

describe("a window refusal that is stricter than the modal's own verdict", () => {
  it("offers the override after M10_TIMEPOINT_EXPIRED for a window the modal judged late, and sends it", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"))
      .mockResolvedValueOnce(ok({ id: "created-1" }));
    const dialog = mount(post, LATE_WINDOW());
    expect(overrideBox(dialog)).toBeNull();
    // The late reason the modal itself asked for is the clinician's choice.
    fireEvent.change(within(dialog).getByLabelText("Late completion reason"), {
      target: { value: "pto" },
    });
    fireEvent.click(record(dialog));
    const override = await within(dialog).findByRole("checkbox", {
      name: /administrative override/,
    });
    fireEvent.click(override);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Justification/ }), {
      target: { value: "The visit was completed on time; the entry was delayed by an outage." },
    });
    fireEvent.click(record(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(bodyOf(post, 1).adminOverride).toBe(true);
    expect(bodyOf(post, 1).lateCompletionReasonCode).toBe("admin_override");
  });

  it("adds nothing, and shows the server's words, when the modal judged the visit before the window opened", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"));
    const dialog = mount(post, FUTURE_WINDOW());
    fireEvent.click(record(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "server words for M10_TIMEPOINT_EXPIRED",
    );
    expect(overrideBox(dialog)).toBeNull();
  });

  it("adds nothing for a late-reason refusal when the modal already judged the visit past the deadline", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(400, "M10_LATE_REASON_REQUIRED"));
    const dialog = mount(post, EXPIRED_WINDOW());
    // The override is already on screen; ticking it is the way out, and the refusal is not swapped for a weaker control.
    expect(overrideBox(dialog)).not.toBeNull();
    fireEvent.click(overrideBox(dialog) as HTMLElement);
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Justification/ }), {
      target: { value: "The visit was completed on time; the entry was delayed by an outage." },
    });
    fireEvent.click(record(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "server words for M10_LATE_REASON_REQUIRED",
    );
    expect(within(dialog).queryByLabelText("Late completion reason")).toBeNull();
  });
});

describe("the explanation of a control the refusal added", () => {
  const ADDED = /\(it has been added\)/;

  it("goes with the control when the visit date changes", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(400, "M10_LATE_REASON_REQUIRED"));
    const dialog = mount(post);
    fireEvent.click(record(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(ADDED);
    fireEvent.change(within(dialog).getByLabelText(/Visit date/), {
      target: { value: "2026-01-05T09:30" },
    });
    expect(within(dialog).queryByLabelText("Late completion reason")).toBeNull();
    expect(within(dialog).queryByText(ADDED)).toBeNull();
  });

  it("goes with the control when the reason for assessment changes", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"));
    const dialog = mount(post);
    fireEvent.click(record(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(ADDED);
    fireEvent.change(within(dialog).getByLabelText("Reason for assessment"), {
      target: { value: "02_huv1" },
    });
    expect(overrideBox(dialog)).toBeNull();
    expect(within(dialog).queryByText(ADDED)).toBeNull();
  });

  it("leaves a different refusal's words on screen when the visit date changes", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_ADMISSION_NOT_ACTIVE"));
    const dialog = mount(post);
    fireEvent.click(record(dialog));
    await within(dialog).findByRole("alert");
    fireEvent.change(within(dialog).getByLabelText(/Visit date/), {
      target: { value: "2026-01-05T09:30" },
    });
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "server words for M10_ADMISSION_NOT_ACTIVE",
    );
  });
});

describe("the visit date the modal opens with", () => {
  const DEFAULTED = /Set to the current time/;

  it("says it is a default until the clinician edits it, and sends the value shown", async () => {
    const post = vi.fn().mockResolvedValueOnce(ok({ id: "created-9" }));
    const dialog = mount(post);
    expect(within(dialog).getByText(DEFAULTED)).toBeTruthy();
    const field = within(dialog).getByLabelText(/Visit date/) as HTMLInputElement;
    const shown = field.value;
    fireEvent.click(record(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(bodyOf(post, 0).targetDate).toBe(new Date(shown).toISOString());
  });

  it("stops saying so once the clinician has entered a date", () => {
    const dialog = mount(vi.fn());
    fireEvent.change(within(dialog).getByLabelText(/Visit date/), {
      target: { value: "2026-01-05T09:30" },
    });
    expect(within(dialog).queryByText(DEFAULTED)).toBeNull();
  });
});
