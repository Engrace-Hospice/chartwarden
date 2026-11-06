// @vitest-environment jsdom
// Step 3, BAA: the business associate agreement between ChartWarden and the tenant. The operator records it (status, dates, the signed
// document's id); the platform settles the step at once when the latest record is executed, has its document and has more than 90 days
// left. The operator who records it cannot also approve go-live (four eyes), so the panel says so.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BaaPanel, baaFacts } from "./baa-panel";
import {
  ok,
  panelCtx,
  refused,
  renderAt,
  stubClient,
  wizardStep,
  wizardView,
} from "./test-support";

const REGISTER = "/api/v1/platform/baa-register";
const ONE = "/api/v1/platform/baa-register/{id}";
const DOC = "9b2f3c4d-1111-4222-8333-444455556666";
type BaaRow = Parameters<typeof baaFacts>[0][number];
// The register's view also carries the organisation and the attestation time; the panel reads only the fields in BaaRow.
const record = (over: Partial<BaaRow> = {}): BaaRow & Record<string, unknown> => ({
  id: "baa-1",
  organizationId: "org-1",
  tenantAccountId: "ta-1",
  addendumVersion: "v1",
  baaStatus: "pending",
  executedOn: null,
  effectiveOn: null,
  expiresOn: null,
  documentId: null,
  attestedAt: null,
  ...over,
});
const view = (over = {}) =>
  wizardView([wizardStep("baa_executed", 1, { title: "BAA", completionMode: "auto" })], over);
function mount(items: unknown[], extra: Parameters<typeof stubClient>[0] = {}, v = view()) {
  const client = stubClient({
    GET: { [REGISTER]: () => ok({ items, nextCursor: null, hasMore: false }) },
    ...extra,
  });
  const ctx = panelCtx(v, "baa_executed");
  renderAt("/x", [{ path: "/x", element: <BaaPanel ctx={ctx} /> }], client);
  return { client, ctx };
}
beforeEach(() => window.sessionStorage.clear());

describe("baaFacts", () => {
  const TODAY = new Date("2026-11-06T00:00:00Z");
  const states = (records: BaaRow[]) =>
    Object.fromEntries(baaFacts(records, TODAY).map((f) => [f.key, f.state]));

  it("has nothing met without a record", () => {
    expect(states([])).toEqual({ executed: "pending", document: "pending", expiry: "pending" });
  });

  it("is met when the latest record is executed, has its document and clears 90 days", () => {
    expect(
      states([record({ baaStatus: "executed", documentId: DOC, expiresOn: "2027-12-31" })]),
    ).toEqual({
      executed: "ok",
      document: "ok",
      expiry: "ok",
    });
  });

  it("blocks an executed BAA that expires within 90 days, and one with no recorded expiry stays pending", () => {
    expect(
      states([record({ baaStatus: "executed", documentId: DOC, expiresOn: "2027-01-15" })]).expiry,
    ).toBe("blocked");
    expect(
      states([record({ baaStatus: "executed", documentId: DOC, expiresOn: null })]).expiry,
    ).toBe("pending");
  });

  it("judges the executed record, not an older pending one", () => {
    const facts = states([
      record({ id: "a", baaStatus: "pending", addendumVersion: "v1" }),
      record({
        id: "b",
        baaStatus: "executed",
        documentId: DOC,
        expiresOn: "2028-01-01",
        addendumVersion: "v2",
      }),
    ]);
    expect(facts.executed).toBe("ok");
  });
});

describe("BaaPanel", () => {
  it("lists the records and the facts, and says the recorder cannot approve go-live", async () => {
    mount([
      record({
        baaStatus: "executed",
        documentId: DOC,
        expiresOn: "2030-01-01",
        executedOn: "2026-10-01",
      }),
    ]);
    expect(await screen.findByText("v1")).toBeTruthy();
    expect(screen.getByText(/cannot also approve go-live/i)).toBeTruthy();
    expect(screen.getByText(/A BAA is executed/).closest("li")?.textContent).toMatch(/Met/);
  });

  it("asks for this tenant's records only", async () => {
    const { client } = mount([]);
    await screen.findByText(/No BAA on record/);
    expect(client.GET).toHaveBeenCalledWith(REGISTER, {
      params: { query: { tenantAccountId: "ta-1" } },
    });
  });

  it("records a new BAA for this tenant, and reloads the wizard", async () => {
    const { client, ctx } = mount([], { POST: { [REGISTER]: () => ok(record(), 201) } });
    await screen.findByText(/No BAA on record/);
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    fireEvent.change(screen.getByLabelText("Addendum version"), { target: { value: "v1" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    fireEvent.change(screen.getByLabelText("Executed on"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Effective on"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Expires on"), { target: { value: "2028-10-01" } });
    fireEvent.change(screen.getByLabelText(/^Signed document id/), { target: { value: DOC } });
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    const [path, init] = client.POST.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe(REGISTER);
    expect((init as { headers?: Record<string, string> }).headers?.["Idempotency-Key"]).toMatch(
      /\S/,
    );
    expect(init.body).toEqual({
      tenantAccountId: "ta-1",
      addendumVersion: "v1",
      baaStatus: "executed",
      executedOn: "2026-10-01",
      effectiveOn: "2026-10-01",
      expiresOn: "2028-10-01",
      documentId: DOC,
    });
    await waitFor(() => expect(ctx.refresh).toHaveBeenCalled());
  });

  it("will not save an executed BAA without its document, and says why", async () => {
    const { client } = mount([]);
    await screen.findByText(/No BAA on record/);
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    expect(screen.getByText(/needs the document id of the signed agreement/i)).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("updates a record with a PATCH to that record", async () => {
    const { client } = mount([record()], {
      PATCH: { [ONE]: () => ok(record({ baaStatus: "executed" })) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit v1" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    fireEvent.change(screen.getByLabelText(/^Signed document id/), { target: { value: DOC } });
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    const [path, init] = client.PATCH.mock.calls[0] as [
      string,
      { params: { path: unknown }; body: Record<string, unknown> },
    ];
    expect(path).toBe(ONE);
    expect(init.params.path).toEqual({ id: "baa-1" });
    expect(init.body).toMatchObject({ baaStatus: "executed", documentId: DOC });
    expect(init.body).not.toHaveProperty("addendumVersion");
  });

  it("explains the server's refusal on a stale step-up with Re-verify", async () => {
    mount([], { POST: { [REGISTER]: () => refused(403, "STEP_UP_REQUIRED") } });
    await screen.findByText(/No BAA on record/);
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    expect(await screen.findByRole("link", { name: /Re-verify/ })).toBeTruthy();
  });

  it("offers no writes when the step cannot be acted on", async () => {
    mount([record()], {}, view({ tenantStatus: "active" }));
    await screen.findByText("v1");
    expect(screen.queryByRole("button", { name: "Record BAA" })).toBeNull();
  });
});

describe("BaaPanel: coming back from Re-verify", () => {
  it("restores an EDIT as an edit: the save is a PATCH to that record, not a second create of the same addendum", async () => {
    mount([record()], { PATCH: { [ONE]: () => refused(403, "STEP_UP_REQUIRED") } });
    fireEvent.click(await screen.findByRole("button", { name: "Edit v1" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    fireEvent.change(screen.getByLabelText(/^Signed document id/), { target: { value: DOC } });
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();

    const { client } = mount([record()], {
      PATCH: { [ONE]: () => ok(record({ baaStatus: "executed" })) },
    });
    expect(((await screen.findByLabelText("Status")) as HTMLSelectElement).value).toBe("executed");
    expect(screen.queryByLabelText("Addendum version")).toBeNull(); // an edit, not a record
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    expect(client.POST).not.toHaveBeenCalled();
    expect(client.PATCH.mock.calls[0]?.[0]).toBe(ONE);
  });
});
