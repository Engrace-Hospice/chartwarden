// The enrollments view (M41): list, manage gating, error states (404 is an error, never "none"), stale-while-revalidate,
// announced outcomes, focus, and the step-up round trip through the whole page. Synthetic data only.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markStepUpReturn, stepUpDraftKeys } from "../../shell/step-up-redirect";
import {
  type Call,
  ENROLLMENT_ID,
  ENTITY_ID,
  PAYER_ID,
  type Responder,
  enrollmentRow,
  entitiesRoute,
  mountScreen,
  payerNameRoute,
  planRow,
} from "./commercial-test-harness";
import { CommercialEnrollments } from "./enrollments";

const PATH = "/commercial/billing/enrollments";
const LIST = "GET /api/v1/billing/commercial/enrollments";
const CREATE = "POST /api/v1/billing/commercial/enrollments";
const PATCH = `PATCH /api/v1/billing/commercial/enrollments/${ENROLLMENT_ID}`;
const BASE = `${PATH}?entity=${ENTITY_ID}`;
const MANAGE = ["commercial_billing.read", "commercial_billing.manage_enrollment"];

function mount(
  list: Responder,
  opts: {
    manage?: boolean;
    entry?: string;
    calls?: Call[];
    write?: Responder;
    plans?: Responder;
    entities?: Responder;
  } = {},
): ReturnType<typeof mountScreen> {
  const write = opts.write ?? (() => ({ status: 201, body: enrollmentRow() }));
  return mountScreen({
    routes: {
      "GET /api/v1/provider-entities": opts.entities ?? entitiesRoute,
      "GET /api/v1/billing/commercial/payer-plans":
        opts.plans ?? (() => ({ body: { items: [planRow(), planRow({ id: "p2" })] } })),
      [`GET /api/v1/mdm/payer/${PAYER_ID}`]: payerNameRoute,
      [LIST]: list,
      [CREATE]: write,
      [PATCH]: write,
    },
    calls: opts.calls ?? [],
    element: <CommercialEnrollments />,
    routePath: PATH,
    entry: opts.entry ?? BASE,
    permissions: opts.manage ? MANAGE : ["commercial_billing.read"],
  });
}
const ok =
  (items: Record<string, unknown>[] = [enrollmentRow()]) =>
  () => ({ body: { items } });
const writes = (calls: Call[]): Call[] => calls.filter((c) => c.method !== "GET");

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

describe("CommercialEnrollments", () => {
  it("lists enrollments with payer name, key, status, dates and the evidence as entered", async () => {
    const calls: Call[] = [];
    mount(ok(), { calls });
    const table = await screen.findByRole("table", { name: "Payer enrollments" });
    const row = (await within(table).findByText("Synthetic Health Plan")).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByText("stedi")).toBeTruthy();
    expect(within(row).getByText("Enrolled")).toBeTruthy();
    expect(within(row).getByText("2026-01-01")).toBeTruthy();
    expect(within(row).getByText("Open-ended")).toBeTruthy();
    expect(within(row).getByText("DOC-123/a#1")).toBeTruthy();
    for (const h of within(table).getAllByRole("columnheader")) {
      expect(h.getAttribute("scope")).toBe("col");
    }
    const read = calls.find((c) => c.method === "GET" && c.path.endsWith("/enrollments"));
    expect(read?.query.get("providerEntityId")).toBe(ENTITY_ID);
  });

  it("hides Add and Edit without manage_enrollment and shows them with it", async () => {
    mount(ok());
    await screen.findByRole("table");
    expect(screen.queryByRole("button", { name: "Add enrollment" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit enrollment/ })).toBeNull();
    cleanup();
    mount(ok(), { manage: true });
    await screen.findByRole("button", { name: "Add enrollment" });
    await screen.findByRole("button", { name: /^Edit enrollment for/ });
  });

  it("shows a 404 as an error with retry, never as none", async () => {
    mount(() => ({ status: 404, body: { error: { code: "NOT_FOUND" } } }));
    await screen.findByText("Enrollments unavailable");
    expect(screen.queryByText("No enrollments recorded")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("recovers on Try again", async () => {
    let n = 0;
    mount(() => {
      n += 1;
      return n === 1 ? { status: 500, body: {} } : { body: { items: [enrollmentRow()] } };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText("DOC-123/a#1");
  });

  it("says plainly when nothing is recorded", async () => {
    mount(ok([]));
    await screen.findByText("No enrollments recorded");
  });

  it("adds an enrollment, announces it, reloads, and lands focus on the heading", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(
      () => {
        n += 1;
        return { body: { items: n === 1 ? [] : [enrollmentRow()] } };
      },
      { manage: true, calls },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add enrollment" }));
    const drawer = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    // The payer choice is deduped by payer: two plans of one payer give one option, named from master data.
    await waitFor(() =>
      expect(within(drawer).getAllByRole("option", { name: "Synthetic Health Plan" })).toHaveLength(
        1,
      ),
    );
    fireEvent.change(within(drawer).getByLabelText(/Payer/), { target: { value: PAYER_ID } });
    fireEvent.change(within(drawer).getByLabelText(/Clearinghouse key/), {
      target: { value: "stedi" },
    });
    fireEvent.change(within(drawer).getByLabelText(/Effective from/), {
      target: { value: "2026-01-01" },
    });
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await screen.findByText("Enrollment added.");
    await waitFor(() =>
      expect(screen.queryByLabelText("Add enrollment", { selector: "aside" })).toBeNull(),
    );
    await within(screen.getByRole("table")).findByText("Enrolled");
    expect(writes(calls)).toHaveLength(1);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("edits a row, keeping the rows and the drawer mounted while the list reloads", async () => {
    let release: (() => void) | undefined;
    let n = 0;
    mount(
      () => {
        n += 1;
        if (n === 1) return { body: { items: [enrollmentRow()] } };
        return new Promise((resolve) => {
          release = () => resolve({ body: { items: [enrollmentRow({ status: "suspended" })] } });
        });
      },
      { manage: true, write: () => ({ status: 409, body: { error: { code: "CONFLICT" } } }) },
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Edit enrollment for/ }));
    const drawer = await screen.findByLabelText("Edit enrollment", { selector: "aside" });
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    const alert = await screen.findByText(/overlaps another enrollment/);
    fireEvent.click(screen.getByRole("button", { name: "Reload list" }));
    await waitFor(() => expect(release).toBeDefined());
    expect(within(screen.getByRole("table")).getByText("Synthetic Health Plan")).toBeTruthy();
    expect(screen.getByLabelText("Edit enrollment", { selector: "aside" })).toBeTruthy();
    expect(alert.isConnected).toBe(true);
    release?.();
    await within(screen.getByRole("table")).findByText("Suspended");
  });

  it("announces a saved edit and returns focus to the page", async () => {
    mount(ok(), { manage: true, write: () => ({ status: 200, body: enrollmentRow() }) });
    fireEvent.click(await screen.findByRole("button", { name: /^Edit enrollment for/ }));
    const drawer = await screen.findByLabelText("Edit enrollment", { selector: "aside" });
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await screen.findByText("Enrollment updated.");
    await waitFor(() =>
      expect(screen.queryByLabelText("Edit enrollment", { selector: "aside" })).toBeNull(),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it("round-trips through step-up: draft restored on return, one save only on the user's submit", async () => {
    const calls: Call[] = [];
    const entry = `${BASE}&enrollment=new`;
    let ceremonyDone = false;
    const write: Responder = () =>
      ceremonyDone
        ? { status: 201, body: enrollmentRow() }
        : { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
    mount(ok([]), { manage: true, calls, entry, write });
    const drawer = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    await within(drawer).findByRole("option", { name: "Synthetic Health Plan" });
    fireEvent.change(within(drawer).getByLabelText(/Payer/), { target: { value: PAYER_ID } });
    fireEvent.change(within(drawer).getByLabelText(/Clearinghouse key/), {
      target: { value: "stedi" },
    });
    fireEvent.change(within(drawer).getByLabelText(/Effective from/), {
      target: { value: "2026-01-01" },
    });
    fireEvent.change(within(drawer).getByLabelText(/Evidence reference/), {
      target: { value: "DOC-7" },
    });
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await screen.findByText("elsewhere");
    expect(document.body.dataset.where).toBe(`/step-up?returnTo=${encodeURIComponent(entry)}`);
    expect(writes(calls)).toHaveLength(1);
    cleanup();

    ceremonyDone = true;
    markStepUpReturn(entry);
    mount(ok([]), { manage: true, calls, entry, write });
    const back = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    await waitFor(() =>
      expect((within(back).getByLabelText(/Payer/) as HTMLSelectElement).value).toBe(PAYER_ID),
    );
    expect((within(back).getByLabelText(/Evidence reference/) as HTMLInputElement).value).toBe(
      "DOC-7",
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(writes(calls)).toHaveLength(1); // nothing re-sent by itself
    fireEvent.submit(back.querySelector("form") as HTMLFormElement);
    await screen.findByText("Enrollment added.");
    expect(writes(calls)).toHaveLength(2);
  });

  it("discards a stale draft on an ordinary visit (no step-up return marker)", async () => {
    const entry = `${BASE}&enrollment=new`;
    const write: Responder = () => ({ status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } });
    mount(ok([]), { manage: true, entry, write });
    const drawer = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    await within(drawer).findByRole("option", { name: "Synthetic Health Plan" });
    fireEvent.change(within(drawer).getByLabelText(/Payer/), { target: { value: PAYER_ID } });
    fireEvent.change(within(drawer).getByLabelText(/Clearinghouse key/), {
      target: { value: "stedi" },
    });
    fireEvent.change(within(drawer).getByLabelText(/Effective from/), {
      target: { value: "2026-01-01" },
    });
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await screen.findByText("elsewhere");
    cleanup();
    mount(ok([]), { manage: true, entry, write });
    const fresh = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    expect((within(fresh).getByLabelText(/Clearinghouse key/) as HTMLInputElement).value).toBe("");
    expect(stepUpDraftKeys().length > 0).toBe(false);
  });

  // Fills the Add form, hits the step-up refusal (draft stashed), and comes back genuinely returned from /step-up.
  async function backFromStepUp(
    entry: string,
    extra: { plans?: Responder; entities?: Responder } = {},
  ): Promise<HTMLElement> {
    const refuse: Responder = () => ({
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED" } },
    });
    mount(ok([]), { manage: true, entry, write: refuse });
    const drawer = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    await within(drawer).findByRole("option", { name: "Synthetic Health Plan" });
    fireEvent.change(within(drawer).getByLabelText(/Payer/), { target: { value: PAYER_ID } });
    fireEvent.change(within(drawer).getByLabelText(/Clearinghouse key/), {
      target: { value: "stedi" },
    });
    fireEvent.change(within(drawer).getByLabelText(/Effective from/), {
      target: { value: "2026-01-01" },
    });
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await screen.findByText("elsewhere");
    const stashed = () => stepUpDraftKeys().length > 0;
    expect(stashed()).toBe(true); // the redirect itself keeps the draft
    cleanup();
    markStepUpReturn(entry);
    mount(ok([]), { manage: true, entry, plans: extra.plans, entities: extra.entities });
    const back = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    await waitFor(() =>
      expect((within(back).getByLabelText(/Clearinghouse key/) as HTMLInputElement).value).toBe(
        "stedi",
      ),
    );
    return back;
  }

  it("closing the restored drawer with X abandons the draft: Add opens blank", async () => {
    await backFromStepUp(`${BASE}&enrollment=new`);
    fireEvent.click(screen.getByRole("button", { name: "Close add enrollment" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("Add enrollment", { selector: "aside" })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add enrollment" }));
    const fresh = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    expect((within(fresh).getByLabelText(/Clearinghouse key/) as HTMLInputElement).value).toBe("");
  });

  it("switching entity away and back does not bring an abandoned draft back", async () => {
    const OTHER = "99999999-9999-4999-8999-999999999999";
    const two: Responder = () => ({
      body: {
        items: [
          {
            id: ENTITY_ID,
            legalName: "Synthetic Hospice",
            ccn: "123456",
            npi: null,
            status: "active",
          },
          { id: OTHER, legalName: "Other Hospice", ccn: "654321", npi: null, status: "active" },
        ],
        nextCursor: null,
      },
    });
    const entry = `${BASE}&enrollment=new`;
    await backFromStepUp(entry, { entities: two });
    const picker = (await screen.findByLabelText("Provider entity")) as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: OTHER } });
    fireEvent.change(picker, { target: { value: ENTITY_ID } });
    fireEvent.click(await screen.findByRole("button", { name: "Add enrollment" }));
    const fresh = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    expect((within(fresh).getByLabelText(/Clearinghouse key/) as HTMLInputElement).value).toBe("");
  });

  it("restores a draft whose payer is no longer offered as 'Choose a payer'", async () => {
    const gone = () => ({
      body: { items: [planRow({ payerId: "77777777-7777-4777-8777-777777777777" })] },
    });
    const back = await backFromStepUp(`${BASE}&enrollment=new`, { plans: gone });
    expect((within(back).getByLabelText(/Payer/) as HTMLSelectElement).value).toBe("");
    expect(within(back).getByRole("option", { name: "Choose a payer" })).toBeTruthy();
    fireEvent.submit(back.querySelector("form") as HTMLFormElement); // the state is cleared, not just the display
    await within(back).findByText("Choose a payer.");
  });

  it("offers only payers whose status is active", async () => {
    const plans = () => ({
      body: {
        items: [
          planRow(),
          planRow({
            id: "p2",
            payerId: "77777777-7777-4777-8777-777777777777",
            payerStatus: "merged",
          }),
        ],
      },
    });
    mount(ok([]), { manage: true, entry: `${BASE}&enrollment=new`, plans });
    const drawer = await screen.findByLabelText("Add enrollment", { selector: "aside" });
    await within(drawer).findByRole("option", { name: "Synthetic Health Plan" });
    expect(within(within(drawer).getByLabelText(/Payer/)).getAllByRole("option")).toHaveLength(2); // "Choose a payer" + the active payer
  });

  it("keeps the rows and the open editor when a reload of the same entity fails", async () => {
    let n = 0;
    mount(
      () => {
        n += 1;
        if (n === 2) return { status: 500, body: {} };
        return { body: { items: [enrollmentRow()] } };
      },
      { manage: true, write: () => ({ status: 409, body: { error: { code: "CONFLICT" } } }) },
    );
    fireEvent.click(await screen.findByRole("button", { name: /^Edit enrollment for/ }));
    const drawer = await screen.findByLabelText("Edit enrollment", { selector: "aside" });
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    fireEvent.click(await screen.findByRole("button", { name: "Reload list" }));
    await screen.findByText(/could not be reloaded/);
    expect(within(screen.getByRole("table")).getByText("Synthetic Health Plan")).toBeTruthy();
    expect(screen.getByLabelText("Edit enrollment", { selector: "aside" })).toBeTruthy();
    expect(screen.queryByText("Enrollments unavailable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/could not be reloaded/)).toBeNull());
  });
});
