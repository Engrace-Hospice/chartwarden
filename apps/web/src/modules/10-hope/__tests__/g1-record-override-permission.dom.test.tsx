// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeRecordModal } from "../hope-record-modal";
import { SESSION, ok } from "./workspace-test-kit";

// Group g1: the server honours `adminOverride` only for a holder of hope.admin.late_deadline_override and answers anyone else 403, so the
// override control (and the words that tell the clinician to tick it) is not offered to a session that is known to lack the permission.
// A session whose permissions are unknown leaves the decision to the server.

afterEach(cleanup);

const OVERRIDE = "hope.admin.late_deadline_override";
const DAY = 24 * 60 * 60 * 1000;
const EXPIRED_WINDOW = () => {
  const now = Date.now();
  return {
    id: "schedule-7",
    rfaKind: "02_huv1",
    windowOpensAt: new Date(now - 30 * DAY).toISOString(),
    windowClosesAt: new Date(now - 20 * DAY).toISOString(),
    lateDeadlineAt: new Date(now - 10 * DAY).toISOString(),
  };
};
const refusal = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: `server words for ${code}` } },
  response: new Response(null, { status }),
});

type Mocked = ReturnType<typeof vi.fn>;
function mount(
  session: unknown,
  post: Mocked,
  window: ReturnType<typeof EXPIRED_WINDOW> | null = null,
) {
  const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
  render(
    <SessionProvider session={session as typeof SESSION}>
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
const overrideBox = (dialog: HTMLElement) =>
  within(dialog).queryByRole("checkbox", { name: /administrative override/ });
const record = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Record draft" }) as HTMLButtonElement;
const withPermissions = (permissions: string[] | undefined) => ({ ...SESSION, permissions });

describe("a visit past the late deadline (judged from the schedule)", () => {
  it("offers the override to a holder of the permission", () => {
    const dialog = mount(withPermissions([OVERRIDE]), vi.fn(), EXPIRED_WINDOW());
    expect(overrideBox(dialog)).not.toBeNull();
  });

  it("does not offer the override to a session that lacks the permission, and says who can record it", () => {
    const dialog = mount(withPermissions(["hope.timepoint.write"]), vi.fn(), EXPIRED_WINDOW());
    expect(overrideBox(dialog)).toBeNull();
    expect(within(dialog).getByText(/administrator with override permission/)).toBeTruthy();
  });

  it("does not offer it with an empty permission list either", () => {
    const dialog = mount(withPermissions([]), vi.fn(), EXPIRED_WINDOW());
    expect(overrideBox(dialog)).toBeNull();
  });

  it("leaves it to the server when the session's permissions are unknown", () => {
    const dialog = mount(withPermissions(undefined), vi.fn(), EXPIRED_WINDOW());
    expect(overrideBox(dialog)).not.toBeNull();
  });

  it("sends no override for a session that lacks the permission", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"));
    const dialog = mount(withPermissions([]), post, EXPIRED_WINDOW());
    fireEvent.click(record(dialog));
    await within(dialog).findByRole("alert");
    const sent = (post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }])[1]
      .body;
    expect(sent.adminOverride).toBeUndefined();
    expect(sent.adminOverrideJustification).toBeUndefined();
  });
});

describe("the refusal M10_TIMEPOINT_EXPIRED on a window the modal judged in time", () => {
  it("tells a holder of the permission to tick the override, and adds it", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"));
    const dialog = mount(withPermissions([OVERRIDE]), post);
    fireEvent.click(record(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Tick the override");
    expect(overrideBox(dialog)).not.toBeNull();
  });

  it("does not tell anyone else to tick a control they cannot use, and adds none", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"));
    const dialog = mount(withPermissions([]), post);
    fireEvent.click(record(dialog));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).not.toContain("Tick the override");
    expect(alert.textContent).toContain("administrator with override permission");
    expect(overrideBox(dialog)).toBeNull();
  });

  it("drops that explanation when the visit date changes, as it does for the other asked controls", async () => {
    const post = vi.fn().mockResolvedValueOnce(refusal(409, "M10_TIMEPOINT_EXPIRED"));
    const dialog = mount(withPermissions([]), post);
    fireEvent.click(record(dialog));
    await within(dialog).findByRole("alert");
    fireEvent.change(within(dialog).getByLabelText(/Visit date/), {
      target: { value: "2026-01-05T09:30" },
    });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });
});
