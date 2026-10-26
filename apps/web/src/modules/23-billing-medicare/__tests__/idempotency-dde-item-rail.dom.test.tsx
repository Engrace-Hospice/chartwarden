import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// #821: DDE item-rail actions keep their Idempotency-Key only after a thrown fetch.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DdeQueue } from "../dde-queue";
import type { DdeItem } from "../dde-queue-model";
import { expectNewKey, expectSameKey } from "./idempotency-test-utils";

const ITEM = "c3d4e5f6-0000-4000-8000-000000000001";

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refused = (status: number) => ({
  data: undefined,
  error: { error: { code: "X", message: "refused" } },
  response: new Response(null, { status }),
});

const ITEM_ROW = {
  ddeWorkItemId: ITEM,
  patientId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  providerEntityId: "77777777-7777-4777-8777-777777777777",
  itemType: "noe",
  subjectKind: "noe_record",
  subjectId: "34343434-3434-4434-8434-343434343434",
  state: "in_progress",
  attemptNumber: 1,
  assigneeMembershipId: "abababab-abab-4bab-8bab-abababababab",
  priority: 1,
  source: "watchdog",
  deadlineAt: "2026-10-10",
  deadlineStatus: "at_risk",
  submittedAt: null,
  macAcceptedOn: null,
  dcn: null,
  rtpReasonCode: null,
  outcomeCode: null,
  notes: null,
  allowedActions: ["claim", "record_submission", "cancel"],
  version: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
} as unknown as DdeItem;

function mount(post: ReturnType<typeof vi.fn>): void {
  const GET = vi.fn(async (path: string) => {
    if (path === "/api/v1/billing/dde-items")
      return ok({ items: [ITEM_ROW], hasMore: false, nextCursor: null });
    if (path === "/api/v1/billing/dde-items/{id}")
      return ok({
        ...ITEM_ROW,
        events: [],
        keying: { screenHint: "hint", fields: [], rejectionCodes: [] },
      });
    return ok({ firstName: "Pat", lastName: "Patient" });
  });
  render(
    <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
      <MemoryRouter initialEntries={[`/billing/dde?item=${ITEM}`]}>
        <Routes>
          <Route path="/billing/dde" element={<DdeQueue />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const rail = async () => within(await screen.findByRole("complementary"));

const press = async (post: ReturnType<typeof vi.fn>, name: string, calls: number) => {
  fireEvent.click((await rail()).getByRole("button", { name }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(calls));
  const r = await rail();
  await waitFor(() =>
    expect((r.queryByRole("button", { name }) as HTMLButtonElement | null)?.disabled ?? false).toBe(
      false,
    ),
  );
};

describe("DDE item rail Idempotency-Key (#821)", () => {
  it("reuses the key when the first request threw", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok({}));
    mount(POST);
    await press(POST, "Take it", 1);
    await press(POST, "Take it", 2);
    expectSameKey(POST, 0, 1);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const POST = vi.fn().mockResolvedValueOnce(refused(422)).mockResolvedValue(ok({}));
    mount(POST);
    await press(POST, "Take it", 1);
    await press(POST, "Take it", 2);
    expectNewKey(POST, 0, 1);
  });

  it("mints a new key when a different action follows a thrown request", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok({}));
    mount(POST);
    await press(POST, "Take it", 1);
    await press(POST, "Cancel item", 2);
    expectNewKey(POST, 0, 1);
  });

  it("mints a new key after a field edit in the keyed-in form following a thrown request", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValue(ok({}));
    mount(POST);
    const r = await rail();
    fireEvent.click(r.getByRole("button", { name: "Record as keyed in DDE" }));
    fireEvent.change(r.getByLabelText(/DCN/), { target: { value: "2212345678901" } });
    const form = r.getByRole("form", { name: "Record as keyed in DDE" });
    fireEvent.submit(form);
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(within(form).getByRole("button", { name: /Record/ })).toBeTruthy());
    fireEvent.change(r.getByLabelText(/DCN/), { target: { value: "2212345678902" } });
    fireEvent.submit(form);
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    expectNewKey(POST, 0, 1);
  });
});
