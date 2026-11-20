// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — the Aide POC's care-team assignment form: the RN picks the plan's aide and
// supervising RN BY NAME from the plan location's roster (never typed ids), and saves them with the plan row version as
// `If-Match`. It refuses to save until both are chosen and something changed, says why a refused save was refused, survives a
// dropped connection, and cannot be used while the roster is unavailable or the plan is discharged.
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AideAssignmentForm, effectivePick } from "../aide-assignment-panel";
import type { AideRoster } from "../aide-roster";
import type { PlanDetail } from "../discipline-api";

const PLAN = "plan-1";
const AIDE = "aaaaaaaa-0000-4000-8000-000000000001";
const AIDE_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const RN = "bbbbbbbb-0000-4000-8000-000000000001";
const RN_2 = "bbbbbbbb-0000-4000-8000-000000000002";
const GONE = "cccccccc-0000-4000-8000-000000000009";

const ROSTER: AideRoster = {
  aides: [
    { membershipId: AIDE, displayName: "Avery Aide", roleKey: "chha" },
    { membershipId: AIDE_2, displayName: "Blake Aide", roleKey: "chha" },
  ],
  supervisors: [
    { membershipId: RN, displayName: "Riley Nurse", roleKey: "rn" },
    { membershipId: RN_2, displayName: "Casey Manager", roleKey: "rn_case_manager" },
  ],
  loading: false,
  error: null,
  nameOf: (id) => id ?? "Not assigned",
  reload: () => undefined,
};

const planWith = (
  aide: string | null,
  rn: string | null,
  over: Partial<PlanDetail> = {},
): PlanDetail =>
  ({
    planId: PLAN,
    status: "active",
    version: 4,
    aideMembershipId: aide,
    supervisingRnMembershipId: rn,
    ...over,
  }) as unknown as PlanDetail;

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const fail = (status: number, title: string) => ({
  data: undefined,
  error: { status, title },
  response: new Response(null, { status }),
});

/** Owns the picks the way the editor screen does (the form itself is controlled). */
function Harness({
  plan,
  roster,
  onSaved,
}: { plan: PlanDetail; roster: AideRoster; onSaved: () => Promise<void> }) {
  const [aidePick, setAidePick] = useState<string | null>(null);
  const [rnPick, setRnPick] = useState<string | null>(null);
  return (
    <AideAssignmentForm
      plan={plan}
      roster={roster}
      aideId={effectivePick(aidePick, plan.aideMembershipId)}
      rnId={effectivePick(rnPick, plan.supervisingRnMembershipId)}
      onAideChange={setAidePick}
      onRnChange={setRnPick}
      onSaved={async () => {
        await onSaved();
        setAidePick(null);
        setRnPick(null);
      }}
    />
  );
}

function renderForm(
  plan: PlanDetail,
  options: {
    roster?: AideRoster;
    put?: ReturnType<typeof vi.fn>;
    onSaved?: () => Promise<void>;
  } = {},
) {
  const put = options.put ?? vi.fn(async () => ok({}));
  const onSaved = options.onSaved ?? vi.fn(async () => undefined);
  const client = { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), PUT: put } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <Harness plan={plan} roster={options.roster ?? ROSTER} onSaved={onSaved} />
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { put, onSaved };
}

const aideSelect = () => screen.getByLabelText("Aide") as HTMLSelectElement;
const rnSelect = () => screen.getByLabelText("Supervising RN") as HTMLSelectElement;
const saveButton = () => screen.getByRole("button", { name: /assign/i }) as HTMLButtonElement;

afterEach(cleanup);

describe("AideAssignmentForm", () => {
  it("offers the roster's people by name, and nothing is saveable until both are picked", () => {
    renderForm(planWith(null, null));
    expect([...aideSelect().options].map((o) => o.textContent)).toEqual([
      "Select an aide",
      "Avery Aide",
      "Blake Aide",
    ]);
    expect([...rnSelect().options].map((o) => o.textContent)).toEqual([
      "Select a supervising RN",
      "Riley Nurse",
      "Casey Manager",
    ]);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(rnSelect(), { target: { value: RN } });
    expect(saveButton().disabled).toBe(false);
  });

  it("saves the picked ids with the plan version as If-Match, then lets the screen reload", async () => {
    const { put, onSaved } = renderForm(planWith(null, null));
    fireEvent.change(aideSelect(), { target: { value: AIDE_2 } });
    fireEvent.change(rnSelect(), { target: { value: RN_2 } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith(
      "/api/v1/discipline-plans/{planId}/aide-assignment",
      expect.objectContaining({
        params: { path: { planId: PLAN }, header: { "If-Match": "4" } },
        body: { aideMembershipId: AIDE_2, supervisingRnMembershipId: RN_2 },
      }),
    );
  });

  it("starts from the plan's current binding and only saves once something changes", () => {
    renderForm(planWith(AIDE, RN));
    expect(aideSelect().value).toBe(AIDE);
    expect(rnSelect().value).toBe(RN);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(aideSelect(), { target: { value: AIDE_2 } });
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps a bound member the roster no longer lists visible, but never selectable again", () => {
    renderForm(planWith(GONE, RN));
    const gone = [...aideSelect().options].find((o) => o.value === GONE);
    expect(gone?.disabled).toBe(true);
    expect(gone?.textContent).toMatch(/not on the staff list/i);
    expect(aideSelect().value).toBe(GONE);
  });

  it("shows why a save was refused and keeps the choice", async () => {
    const put = vi.fn(async () =>
      fail(422, "the chosen aide is not an active aide at this plan's location"),
    );
    const { onSaved } = renderForm(planWith(null, null), { put });
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    fireEvent.change(rnSelect(), { target: { value: RN } });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/not an active aide/i);
    expect(onSaved).not.toHaveBeenCalled();
    expect(aideSelect().value).toBe(AIDE);
    expect(saveButton().disabled).toBe(false);
  });

  it("survives a dropped connection: says so, and re-enables the button", async () => {
    const put = vi.fn(async () => {
      throw new TypeError("network down");
    });
    renderForm(planWith(null, null), { put });
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    fireEvent.change(rnSelect(), { target: { value: RN } });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/may not have been saved/i);
    expect(screen.getByRole("button", { name: /reload plan/i })).toBeTruthy();
  });

  it("cannot be used while the staff list is unavailable, and offers a retry", () => {
    const reload = vi.fn();
    renderForm(planWith(null, null), {
      roster: {
        ...ROSTER,
        aides: [],
        supervisors: [],
        error: "The staff list could not be loaded.",
        reload,
      },
    });
    expect(aideSelect().disabled).toBe(true);
    expect(rnSelect().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(reload).toHaveBeenCalled();
  });

  it("is read-only on a discharged plan", () => {
    renderForm(planWith(AIDE, RN, { status: "discharged" }));
    expect(aideSelect().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/discharged/i)).toBeTruthy();
  });
  it("treats a 409 as a stale plan: says so and offers a reload instead of resending the old version", async () => {
    const put = vi.fn(async () => fail(409, "stale"));
    const { onSaved } = renderForm(planWith(null, null), { put });
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    fireEvent.change(rnSelect(), { target: { value: RN } });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /changed while you were working/i,
    );
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /reload plan/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /reload plan/i })).toBeNull());
  });

  it("does not call a saved assignment 'not saved' when only the screen refresh failed", async () => {
    const onSaved = vi.fn(async () => {
      throw new TypeError("network down");
    });
    renderForm(planWith(null, null), { onSaved });
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    fireEvent.change(rnSelect(), { target: { value: RN } });
    fireEvent.click(saveButton());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/was saved, but the screen could not refresh/i);
    expect(alert.textContent).not.toMatch(/may not have been saved/i);
  });

  it("an empty-bodied failure (a proxy 502) is a failure, not a success", async () => {
    const put = vi.fn(async () => ({
      data: undefined,
      error: "",
      response: new Response(null, { status: 502 }),
    }));
    const { onSaved } = renderForm(planWith(null, null), { put });
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    fireEvent.change(rnSelect(), { target: { value: RN } });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be saved/i);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("reads the server's own message from the standard error envelope and clears it on the next pick", async () => {
    const put = vi.fn(async () => ({
      data: undefined,
      error: {
        error: {
          code: "AIDE_NOT_ELIGIBLE",
          message: "the chosen aide is not an active aide at this plan's location",
        },
      },
      response: new Response(null, { status: 422 }),
    }));
    renderForm(planWith(null, null), { put });
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    fireEvent.change(rnSelect(), { target: { value: RN } });
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/not an active aide/i);
    fireEvent.change(aideSelect(), { target: { value: AIDE_2 } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("will not save while the plan's bound member is no longer on the roster (the server would refuse it)", () => {
    renderForm(planWith(GONE, RN));
    fireEvent.change(rnSelect(), { target: { value: RN_2 } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(aideSelect(), { target: { value: AIDE } });
    expect(saveButton().disabled).toBe(false);
  });
});
