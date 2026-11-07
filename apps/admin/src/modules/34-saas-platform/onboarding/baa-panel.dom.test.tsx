// @vitest-environment jsdom
// Step 3, BAA: the business associate agreement between ChartWarden and the tenant. The operator uploads the signed agreement (its own
// permission, a fresh step-up and a reason) and records the BAA (status, dates) with the document id the upload returned; the platform
// settles the step at once when the latest record is executed, has its document and has more than 90 days left. The operator who
// records it cannot also approve go-live (four eyes), so the panel says so.
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

const UPLOAD = "/api/v1/platform/tenants/{orgSlug}/baa-document";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PDF_BASE64 = btoa(String.fromCharCode(...PDF_BYTES));
const pdf = (name = "signed-baa.pdf") => new File([PDF_BYTES], name, { type: "application/pdf" });
const UPLOADED = {
  documentId: DOC,
  mimeType: "application/pdf",
  byteSize: PDF_BYTES.byteLength,
  sha256Hex: "a".repeat(64),
};
/** Choose a file, wait for it to be read, ask for the upload and answer the reason prompt. */
async function chooseAndUpload(file: File = pdf(), reason = "Signed BAA from the customer, CHG-5") {
  fireEvent.change(screen.getByLabelText(/^Signed agreement/), { target: { files: [file] } });
  const ask = screen.getByRole("button", { name: "Upload agreement" }) as HTMLButtonElement;
  await waitFor(() => expect(ask.disabled).toBe(false));
  fireEvent.click(ask);
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: reason } });
  fireEvent.click(screen.getByRole("button", { name: "Upload" }));
}

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
    const { client, ctx } = mount([], {
      POST: { [REGISTER]: () => ok(record(), 201), [UPLOAD]: () => ok(UPLOADED, 201) },
    });
    await screen.findByText(/No BAA on record/);
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    fireEvent.change(screen.getByLabelText("Addendum version"), { target: { value: "v1" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    fireEvent.change(screen.getByLabelText("Executed on"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Effective on"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("Expires on"), { target: { value: "2028-10-01" } });
    await chooseAndUpload();
    await screen.findByText(/Uploaded signed-baa\.pdf/);
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    const [path, init] = client.POST.mock.calls[1] as [string, { body: Record<string, unknown> }];
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
    expect(screen.getByText(/needs the signed agreement: upload it first/i)).toBeTruthy();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("updates a record with a PATCH to that record", async () => {
    const { client } = mount([record()], {
      PATCH: { [ONE]: () => ok(record({ baaStatus: "executed" })) },
      POST: { [UPLOAD]: () => ok(UPLOADED, 201) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit v1" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    await chooseAndUpload();
    await screen.findByText(/Uploaded signed-baa\.pdf/);
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
    mount([record()], {
      PATCH: { [ONE]: () => refused(403, "STEP_UP_REQUIRED") },
      POST: { [UPLOAD]: () => ok(UPLOADED, 201) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit v1" }));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    await chooseAndUpload();
    await screen.findByText(/Uploaded signed-baa\.pdf/);
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

  it("restores a CREATE as a create: a POST of the same new addendum, never a PATCH of the record on file now", async () => {
    mount([], {
      POST: {
        [REGISTER]: () => refused(403, "STEP_UP_REQUIRED"),
        [UPLOAD]: () => ok(UPLOADED, 201),
      },
    });
    await screen.findByText(/No BAA on record/);
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    fireEvent.change(screen.getByLabelText("Addendum version"), { target: { value: "v2" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    await chooseAndUpload();
    await screen.findByText(/Uploaded signed-baa\.pdf/);
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();

    // a record exists when the operator comes back: the resumed form is still the create, with what was typed
    const { client } = mount([record()], { POST: { [REGISTER]: () => ok(record(), 201) } });
    expect(((await screen.findByLabelText("Addendum version")) as HTMLInputElement).value).toBe(
      "v2",
    );
    expect(screen.getByRole("heading", { name: "Record a BAA" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.PATCH).not.toHaveBeenCalled();
    const [path, init] = client.POST.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(path).toBe(REGISTER);
    expect(init.body).toMatchObject({
      addendumVersion: "v2",
      baaStatus: "executed",
      documentId: DOC,
    });
  });
});

describe("BaaPanel: uploading the signed agreement", () => {
  const openNew = async (extra: Parameters<typeof stubClient>[0] = {}) => {
    const mounted = mount([], extra);
    await screen.findByText(/No BAA on record/);
    fireEvent.click(screen.getByRole("button", { name: "Record BAA" }));
    return mounted;
  };

  it("replaces the document-id paste with a file chooser", async () => {
    await openNew();
    expect(screen.getByLabelText(/^Signed agreement/)).toBeTruthy();
    expect(screen.queryByLabelText(/Signed document id/)).toBeNull();
  });

  it("uploads the file for this tenant with a reason, an Idempotency-Key and the file's bytes, then says it is ready to link", async () => {
    const { client } = await openNew({ POST: { [UPLOAD]: () => ok(UPLOADED, 201) } });
    await chooseAndUpload(pdf(), "Signed BAA from the customer, CHG-5");
    await screen.findByText(/Uploaded signed-baa\.pdf/);
    expect(client.POST).toHaveBeenCalledTimes(1);
    const [path, init] = client.POST.mock.calls[0] as [
      string,
      {
        params: { path: unknown; header: Record<string, string> };
        body: Record<string, unknown>;
      },
    ];
    expect(path).toBe(UPLOAD);
    expect(init.params.path).toEqual({ orgSlug: "cedar-ridge" });
    expect(init.params.header["Idempotency-Key"]).toMatch(/\S/);
    expect(init.body).toEqual({
      contentBase64: PDF_BASE64,
      mimeType: "application/pdf",
      reason: "Signed BAA from the customer, CHG-5",
    });
    // nothing is recorded until the operator saves the BAA
    expect(client.POST.mock.calls.map((c) => c[0])).not.toContain(REGISTER);
  });

  it("refuses a file of the wrong type, an empty one and an oversized one before any request, and keeps the upload closed", async () => {
    const { client } = await openNew();
    const choose = (file: File) =>
      fireEvent.change(screen.getByLabelText(/^Signed agreement/), { target: { files: [file] } });
    choose(new File(["plain"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText(/PDF, JPEG, PNG, TIFF or Word/)).toBeTruthy();
    choose(new File([], "empty.pdf", { type: "application/pdf" }));
    expect(await screen.findByText(/file is empty/i)).toBeTruthy();
    const big = new File([new Uint8Array(1)], "big.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 25 * 1024 * 1024 + 1 });
    choose(big);
    expect(await screen.findByText(/at most 25 MB/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Upload agreement" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("shows the server's refusal of the file in the prompt, keeps the prompt open and links nothing", async () => {
    const { client } = await openNew({
      POST: {
        [UPLOAD]: () =>
          refused(
            415,
            "UPLOAD_CONTENT_MISMATCH",
            "document content does not match the declared MIME type",
          ),
      },
    });
    await chooseAndUpload();
    expect(await screen.findByText(/does not match the declared MIME type/)).toBeTruthy();
    expect(screen.queryByText(/Uploaded signed-baa\.pdf/)).toBeNull();
    expect(client.POST).toHaveBeenCalledTimes(1);
  });

  it("offers Re-verify on a stale step-up, and after it keeps what was typed but asks for the file again", async () => {
    await openNew({ POST: { [UPLOAD]: () => refused(403, "STEP_UP_REQUIRED") } });
    fireEvent.change(screen.getByLabelText("Addendum version"), { target: { value: "v7" } });
    await chooseAndUpload();
    fireEvent.click(await screen.findByRole("link", { name: /Re-verify/ }));
    cleanup();

    mount([]);
    expect(((await screen.findByLabelText("Addendum version")) as HTMLInputElement).value).toBe(
      "v7",
    );
    expect(
      (screen.getByRole("button", { name: "Upload agreement" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps the document already linked to a record when the operator edits it without choosing a file", async () => {
    const { client } = mount([record({ baaStatus: "pending", documentId: DOC })], {
      PATCH: { [ONE]: () => ok(record({ baaStatus: "executed", documentId: DOC })) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit v1" }));
    expect(screen.getByText(/A signed agreement is linked/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "executed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save BAA" }));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalledTimes(1));
    expect(client.PATCH.mock.calls[0]?.[1]).toMatchObject({
      body: { baaStatus: "executed", documentId: DOC },
    });
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("offers no upload when the step cannot be acted on", async () => {
    mount([record()], {}, view({ tenantStatus: "active" }));
    await screen.findByText("v1");
    expect(screen.queryByLabelText(/^Signed agreement/)).toBeNull();
  });
});
