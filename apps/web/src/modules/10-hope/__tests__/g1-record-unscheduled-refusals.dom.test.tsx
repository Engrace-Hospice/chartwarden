// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeRecordModal } from "../hope-record-modal";
import { SESSION, ok } from "./workspace-test-kit";

// Group g1: a capture opened with no schedule window (the patient timeline's "Record timepoint") cannot judge the window itself,
// so a refusal that asks for a late reason (M10_LATE_REASON_REQUIRED) or an override (M10_TIMEPOINT_EXPIRED) must give the
// clinician the control that answers it, instead of repeating the server's sentence over a form that cannot.

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
function render_(post: Mocked, window: Parameters<typeof HopeRecordModal>[0]["window"] = null) {
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <SessionProvider session={SESSION}>
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

describe("an unscheduled capture refused for the window", () => {
  it("offers the late-completion reason after M10_LATE_REASON_REQUIRED, and sends the one chosen", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(400, "M10_LATE_REASON_REQUIRED"))
      .mockResolvedValueOnce(ok({ id: "created-1" }));
    const dialog = render_(post);
    expect(within(dialog).queryByLabelText("Late completion reason")).toBeNull();
    fireEvent.click(record(dialog));
    const reason = (await within(dialog).findByLabelText(
      "Late completion reason",
    )) as HTMLSelectElement;
    // The control is the way out, so Record waits for the choice instead of sending the same request again.
    expect(record(dialog).disabled).toBe(true);
    expect(bodyOf(post, 0).lateCompletionReasonCode).toBeUndefined();
    fireEvent.change(reason, { target: { value: "hospitalization" } });
    fireEvent.click(record(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(bodyOf(post, 1).lateCompletionReasonCode).toBe("hospitalization");
    expect(bodyOf(post, 1).adminOverride).toBeUndefined();
  });

  it("offers the administrative override after M10_TIMEPOINT_EXPIRED, and sends it with its justification", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"))
      .mockResolvedValueOnce(ok({ id: "created-2" }));
    const dialog = render_(post);
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
    expect(typeof bodyOf(post, 1).adminOverrideJustification).toBe("string");
  });

  it("takes the control away, and sends nothing for it, once the visit date changes", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(refusal(400, "M10_LATE_REASON_REQUIRED"))
      .mockResolvedValueOnce(ok({ id: "created-3" }));
    const dialog = render_(post);
    fireEvent.click(record(dialog));
    const reason = (await within(dialog).findByLabelText(
      "Late completion reason",
    )) as HTMLSelectElement;
    fireEvent.change(reason, { target: { value: "pto" } });
    // The server judged THIS date: a different one may need no reason at all, and a hidden control's value is not sent.
    fireEvent.change(within(dialog).getByLabelText(/Visit date/), {
      target: { value: "2026-01-05T09:30" },
    });
    expect(within(dialog).queryByLabelText("Late completion reason")).toBeNull();
    fireEvent.click(record(dialog));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(bodyOf(post, 1).lateCompletionReasonCode).toBeUndefined();
  });

  it("also answers it for a schedule whose stored window looked in time", async () => {
    const now = Date.now();
    const inTime = {
      id: "schedule-7",
      rfaKind: "02_huv1",
      windowOpensAt: new Date(now - 5 * DAY).toISOString(),
      windowClosesAt: new Date(now + 5 * DAY).toISOString(),
      lateDeadlineAt: new Date(now + 12 * DAY).toISOString(),
    };
    const post = vi.fn().mockResolvedValueOnce(refusal(400, "M10_LATE_REASON_REQUIRED"));
    const dialog = render_(post, inTime);
    expect(within(dialog).queryByLabelText("Late completion reason")).toBeNull();
    fireEvent.click(record(dialog));
    expect(await within(dialog).findByLabelText("Late completion reason")).toBeTruthy();
  });

  it("leaves any other refusal as the server's own words, with no control added", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_ADMISSION_NOT_ACTIVE"));
    const dialog = render_(post);
    fireEvent.click(record(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "server words for M10_ADMISSION_NOT_ACTIVE",
    );
    expect(within(dialog).queryByLabelText("Late completion reason")).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: /administrative override/ })).toBeNull();
  });
});
