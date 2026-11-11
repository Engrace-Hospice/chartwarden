// @vitest-environment jsdom
// The operator's drawer of what a tenant recorded as filed outside ChartWarden (NOEs and NOTRs). A tenant cannot undo such a record and a
// cancel refuses, so a mistaken or false one would be permanent: the operator withdraws it here. The withdrawal is PINNED to the record read
// (If-Match = its recordedAt): a record the tenant re-recorded meanwhile is shown anew and needs a second, deliberate confirm.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NoticeFilingsDrawer } from "./notice-filings-drawer";
import { ONBOARDING_OPERATOR, ok, refused, renderAt, stubClient } from "./onboarding/test-support";

const LIST = "/api/v1/platform/tenants/{orgSlug}/notice-filings";
const NOE_WITHDRAW = "/api/v1/platform/tenants/{orgSlug}/noe-records/{id}/withdraw-external-filing";
const NOTR_WITHDRAW =
  "/api/v1/platform/tenants/{orgSlug}/notr-records/{id}/withdraw-external-filing";
const NOE_ID = "11111111-1111-4111-8111-111111111111";
const NOTR_ID = "22222222-2222-4222-8222-222222222222";
const RECORDED = "2026-11-05T09:00:00.123Z";
const RECORDED_AGAIN = "2026-11-07T14:15:00.456Z";

const noe = (over = {}) => ({
  noticeKind: "noe",
  noticeId: NOE_ID,
  state: "ready",
  windowTargetAt: "2026-11-06",
  windowBreachedAt: null,
  filedOn: "2026-11-04",
  recordedAt: RECORDED,
  breachStampFromRecord: false,
  ...over,
});
const notr = (over = {}) => ({
  noticeKind: "notr",
  noticeId: NOTR_ID,
  state: "draft",
  windowTargetAt: "2026-11-06",
  windowBreachedAt: "2026-11-08",
  filedOn: "2026-11-08",
  recordedAt: "2026-11-09T10:00:00.000Z",
  breachStampFromRecord: true,
  ...over,
});
const REASON = "Tenant filed this in error; confirmed by phone, ticket CHG-7001";

function mount(
  list: () => ReturnType<typeof ok>,
  extra: Parameters<typeof stubClient>[0] = {},
  onClose = vi.fn(),
  session: Parameters<typeof renderAt>[3] = ONBOARDING_OPERATOR,
) {
  const client = stubClient({ GET: { [LIST]: list }, ...extra });
  renderAt(
    "/x",
    [{ path: "/x", element: <NoticeFilingsDrawer orgSlug="cedar-ridge" onClose={onClose} /> }],
    client,
    session,
  );
  return { client, onClose };
}
const body = (items: unknown[], truncated = false) => ok({ items, truncated });
const confirm = (reason: string, name: RegExp | string) => {
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name }));
};
const withdrawNoe = async () =>
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Withdraw the NOE record 11111111, filed on 2026-11-04",
    }),
  );
const lastCall = (calls: unknown[][]) =>
  calls.at(-1) as [
    string,
    { params: { path: Record<string, string>; header: Record<string, string> }; body: unknown },
  ];

describe("NoticeFilingsDrawer: the list", () => {
  it("lists each notice the tenant recorded as filed outside, with its dates, and carries nothing that names a patient", async () => {
    mount(() => body([notr(), noe()]));
    expect(await screen.findByText("NOTR")).toBeTruthy();
    expect(screen.getByText("NOE")).toBeTruthy();
    expect(screen.getAllByText("2026-11-04").length).toBeGreaterThan(0);
    // a late record that wrote its own breach stamp says what withdrawing it does to the stamp
    expect(screen.getByText(/written by this record/i)).toBeTruthy();
  });

  it("tells two records filed on the same day apart: the id prefix is in each Withdraw button's name", async () => {
    mount(() =>
      body([
        noe(),
        noe({ noticeId: "33333333-3333-4333-8333-333333333333", recordedAt: RECORDED_AGAIN }),
      ]),
    );
    await screen.findAllByRole("button", { name: /^Withdraw the NOE record/ });
    expect(
      screen.getByRole("button", { name: "Withdraw the NOE record 11111111, filed on 2026-11-04" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Withdraw the NOE record 33333333, filed on 2026-11-04" }),
    ).toBeTruthy();
  });

  it("without the withdraw key, lists the records but offers no Withdraw, and says why once", async () => {
    mount(() => body([notr(), noe()]), {}, vi.fn(), {
      ...ONBOARDING_OPERATOR,
      permissions:
        ONBOARDING_OPERATOR.permissions?.filter(
          (k) => k !== "tenant_notice_filing.withdraw_platform",
        ) ?? [],
    });
    expect(await screen.findByText("NOTR")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Withdraw the/ })).toBeNull();
    expect(screen.getAllByText(/Your role cannot withdraw a record/)).toHaveLength(1);
  });

  it("says when the tenant recorded nothing", async () => {
    mount(() => body([]));
    expect(await screen.findByText(/has not recorded any notice as filed outside/i)).toBeTruthy();
  });

  it("says when the list was cut, so an old record is not mistaken for missing", async () => {
    mount(() => body([noe()], true));
    expect(await screen.findByText(/most recent 200/i)).toBeTruthy();
  });

  it("says when it could not load, and offers to try again", async () => {
    let reads = 0;
    mount(() => {
      reads += 1;
      return reads === 1 ? (refused(500, "INTERNAL", "boom") as never) : body([noe()]);
    });
    expect(await screen.findByText(/Could not load/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("NOE")).toBeTruthy();
  });

  it("closes from its own button", async () => {
    const { onClose } = mount(() => body([noe()]));
    await screen.findByText("NOE");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("NoticeFilingsDrawer: withdrawing a record", () => {
  it("shows what is being withdrawn and what it does, then pins the call to the record's recordedAt", async () => {
    const { client } = mount(() => body([noe()]), {
      POST: { [NOE_WITHDRAW]: () => ok({ noticeKind: "noe", noticeId: NOE_ID }) },
    });
    await withdrawNoe();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(`NOE ${NOE_ID}`)).toBeTruthy();
    expect(dialog.getByText("2026-11-04")).toBeTruthy();
    expect(dialog.getByText(/pre-record state|before the tenant recorded it/i)).toBeTruthy();
    confirm(REASON, "Withdraw record");

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = lastCall(client.POST.mock.calls);
    expect(path).toBe(NOE_WITHDRAW);
    expect(init.params.path).toEqual({ orgSlug: "cedar-ridge", id: NOE_ID });
    expect(init.params.header["If-Match"]).toBe(RECORDED);
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({ reason: REASON });
    // the list is read again, and the dialog is gone
    await waitFor(() =>
      expect(client.GET.mock.calls.filter((c) => c[0] === LIST).length).toBeGreaterThan(1),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("withdraws a NOTR through its own route, and says a late record's own breach stamp is cleared with it", async () => {
    const { client } = mount(() => body([notr()]), {
      POST: { [NOTR_WITHDRAW]: () => ok({ noticeKind: "notr", noticeId: NOTR_ID }) },
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Withdraw the NOTR record 22222222, filed on 2026-11-08",
      }),
    );
    expect(
      within(screen.getByRole("dialog")).getByText(/stamp this late record wrote is cleared/i),
    ).toBeTruthy();
    confirm(REASON, "Withdraw record");
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(lastCall(client.POST.mock.calls)[0]).toBe(NOTR_WITHDRAW);
    expect(lastCall(client.POST.mock.calls)[1].params.header["If-Match"]).toBe(
      "2026-11-09T10:00:00.000Z",
    );
  });

  it("when the tenant re-recorded the filing meanwhile: says so, shows the new record, and the second confirm pins the NEW one", async () => {
    let reads = 0;
    const { client } = mount(
      () => {
        reads += 1;
        return body([
          reads === 1 ? noe() : noe({ filedOn: "2026-11-05", recordedAt: RECORDED_AGAIN }),
        ]);
      },
      {
        POST: {
          [NOE_WITHDRAW]: (init) =>
            (init as { params?: { header?: Record<string, string> } }).params?.header?.[
              "If-Match"
            ] === RECORDED
              ? refused(409, "NOTICE_FILING_RECORD_CHANGED", "changed", [
                  { field: "currentRecordedAt", code: "X", message: RECORDED_AGAIN },
                ])
              : ok({ noticeKind: "noe", noticeId: NOE_ID }),
        },
      },
    );
    await withdrawNoe();
    confirm(REASON, "Withdraw record");

    expect(await screen.findByText(/This record changed since you opened it/)).toBeTruthy();
    const dialog = within(screen.getByRole("dialog"));
    await waitFor(() => expect(dialog.getByText("2026-11-05")).toBeTruthy());
    expect(client.POST).toHaveBeenCalledTimes(1);
    fireEvent.click(dialog.getByRole("button", { name: /Confirm the updated record/ }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(lastCall(client.POST.mock.calls)[1].params.header["If-Match"]).toBe(RECORDED_AGAIN);
  });

  it("treats a missing pin (428) like a changed record: re-reads, shows what it says now, asks again", async () => {
    let reads = 0;
    const { client } = mount(
      () => {
        reads += 1;
        return body([noe({ recordedAt: reads === 1 ? RECORDED : RECORDED_AGAIN })]);
      },
      { POST: { [NOE_WITHDRAW]: () => refused(428, "IF_MATCH_REQUIRED", "needs the record") } },
    );
    await withdrawNoe();
    confirm(REASON, "Withdraw record");
    expect(await screen.findByText(/This record changed since you opened it/)).toBeTruthy();
    expect(client.POST).toHaveBeenCalledTimes(1);
  });

  it("closes the dialog when the record is gone (another operator withdrew it) instead of leaving it to reappear", async () => {
    let reads = 0;
    mount(
      () => {
        reads += 1;
        return body(reads === 1 ? [noe()] : []);
      },
      {
        POST: {
          [NOE_WITHDRAW]: () => refused(409, "NOTICE_NOT_FILED_EXTERNALLY", "nothing to withdraw"),
        },
      },
    );
    await withdrawNoe();
    confirm(REASON, "Withdraw record");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/has not recorded any notice as filed outside/i)).toBeTruthy();
  });

  it("offers Re-verify when the sign-in is not recent enough, and sends nothing a second time on its own", async () => {
    const { client } = mount(() => body([noe()]), {
      POST: { [NOE_WITHDRAW]: () => refused(403, "STEP_UP_REQUIRED", "step up") },
    });
    await withdrawNoe();
    confirm(REASON, "Withdraw record");
    expect(await screen.findByRole("link", { name: /Re-verify/ })).toBeTruthy();
    expect(client.POST).toHaveBeenCalledTimes(1);
  });
});
