// apps/web/src/modules/25-remittance — milestone 13a beneficiary-appeal and representative UI. The screens invent nothing: no
// form configured, no appointment, no validity end and no due date each read as exactly that; filer, level and kind start at
// "Choose..."; a second person is required to activate and the button explains why it is off; a refused or stale save keeps
// what was typed behind a visible cue; a failed reload keeps the list with a Retry; an out-of-order response never wins; the
// step-up round trip restores typed work; irreversible moves ask first.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { markStepUpReturn } from "../../shell/step-up-redirect";
import { BeneficiaryAppealPanel } from "./beneficiary-appeal-panel";
import {
  CHANGED_CUE,
  NO_APPOINTMENT,
  NO_DUE_DATE_ENTER,
  NO_FORM_CONFIGURED,
  RECORDS_NOT_FILES,
  VALIDITY_NOT_RECORDED,
  VALIDITY_PASSED,
} from "./beneficiary-copy";
import { RepresentativeFormSettings } from "./representative-form-settings";
import { RepresentativePanel } from "./representative-panel";

const CLAIM = "cccccccc-4444-4444-8444-cccccccccccc";
const ME = "mmmmmmmm-4444-4444-8444-mmmmmmmmmmmm";
const OTHER = "oooooooo-4444-4444-8444-oooooooooooo";
const DOC = "dddddddd-4444-4444-8444-dddddddddddd";
const VER = "eeeeeeee-4444-4444-8444-eeeeeeeeeeee";

const appointment = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  patientId: "p1",
  recordedFromClaimId: CLAIM,
  instrumentKind: "org_form",
  formVersionId: "f1",
  formLabel: "Org form A",
  instrumentNote: null,
  representativeName: "Fixture Person",
  relationshipLabel: "daughter",
  representativeKind: "family_or_friend",
  beneficiarySignedOn: null,
  representativeSignedOn: null,
  validThroughOn: null,
  validitySourceNote: null,
  elements: [{ label: "Element one", state: "confirmed" }],
  documentId: DOC,
  documentVersionId: VER,
  state: "draft",
  status: "draft",
  recordedByMembershipId: OTHER,
  verifiedByMembershipId: null,
  verifiedAt: null,
  revokedOn: null,
  revocationNote: null,
  version: 3,
  ...over,
});
const appeal = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  claimId: CLAIM,
  patientId: "p1",
  denialCaseId: null,
  filerKind: "representative",
  representativeAppointmentId: null,
  appointment: null,
  representativeStatus: "none_on_file",
  tierLabel: "redetermination",
  filedOn: null,
  externalReference: null,
  sourceNote: "family telephoned",
  state: "recorded",
  outcomeLabel: null,
  outcomeNote: null,
  closedAt: null,
  version: 2,
  documents: [],
  deadlines: [],
  ...over,
});

type Handler = (body: unknown) => Response | Promise<Response>;
let handlers: Record<string, Handler>;
let calls: { key: string; body: unknown }[];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok =
  (body: unknown): Handler =>
  () =>
    json(200, body);
const callsTo = (key: string) => calls.filter((c) => c.key === key);

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const key = `${method} ${path}`;
  let body: unknown = null;
  try {
    const text = req ? await req.clone().text() : String(init?.body ?? "");
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  calls.push({ key, body });
  const handler = handlers[key];
  return handler ? handler(body) : json(404, {});
}

const APPTS = `GET /api/v1/claims/${CLAIM}/representative-appointments`;
const APPEALS = `GET /api/v1/claims/${CLAIM}/beneficiary-appeals`;
const FORMS = "GET /api/v1/representative-form-versions";
const listOf = (items: unknown[]) => ok({ claimId: CLAIM, patientId: "p1", items });

function Providers(props: {
  children: JSX.Element;
  permissions?: string[];
  path?: string;
}): JSX.Element {
  // One client per mounted tree: a new client would look like a new fetcher and (correctly) clear the list.
  const [client] = useState(() =>
    createApiClient({ baseUrl: "http://localhost", fetch: stubFetch }),
  );
  return (
    <ApiClientProvider client={client}>
      <SessionProvider
        session={{
          userId: "u1",
          organizationId: "org-1",
          membershipId: ME,
          roles: ["billing_specialist"],
          permissions: props.permissions ?? [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[props.path ?? "/claim"]}>
            <Routes>
              <Route path="/step-up" element={<p>STEP-UP PAGE</p>} />
              <Route path="*" element={props.children} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>
  );
}
function mount(element: JSX.Element, permissions: string[] = []) {
  const view = render(<Providers permissions={permissions}>{element}</Providers>);
  return {
    rerender: (next: JSX.Element) =>
      view.rerender(<Providers permissions={permissions}>{next}</Providers>),
  };
}
const pick = (label: string, value: string) =>
  userEvent.selectOptions(screen.getByLabelText(label), value);
const setDate = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  calls = [];
  window.sessionStorage.clear();
  handlers = {
    [APPTS]: listOf([]),
    [APPEALS]: listOf([]),
    [FORMS]: ok({ items: [] }),
  };
});
afterEach(() => cleanup());

describe("RepresentativePanel", () => {
  it("with none on file says so, states that it grants nothing", async () => {
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    expect(await screen.findByText(NO_APPOINTMENT)).toBeTruthy();
    expect(screen.getByText(/no portal access, consent or caregiver status/)).toBeTruthy();
  });

  it("the create form has no invented defaults, says no form is configured and explains its disabled submit", async () => {
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(await screen.findByRole("button", { name: "Record an appointment" }));
    expect(await screen.findByText(NO_FORM_CONFIGURED)).toBeTruthy();
    expect((screen.getByLabelText("Representative kind") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Instrument") as HTMLSelectElement).value).toBe("");
    const submit = screen.getByRole("button", { name: "Record draft" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(submit.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/Choose the instrument/);
  });

  it("records a draft from the organization's form version, sending only what was typed", async () => {
    handlers[FORMS] = ok({
      items: [
        {
          id: "f1",
          label: "Org form A",
          formIdentifier: "as entered",
          editionText: null,
          sourceNote: "s",
          verifiedOn: null,
          verifiedByMembershipId: null,
          requiredElements: ["E"],
          retiredAt: null,
          version: 1,
        },
      ],
    });
    handlers[`POST /api/v1/claims/${CLAIM}/representative-appointments`] = () =>
      json(201, { id: "a9", version: 1 });
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(await screen.findByRole("button", { name: "Record an appointment" }));
    await screen.findByRole("option", { name: /Org form A/ });
    await pick("Instrument", "f1");
    await userEvent.type(screen.getByLabelText("Representative's name"), "New Person");
    await pick("Representative kind", "attorney");
    await userEvent.click(screen.getByRole("button", { name: "Record draft" }));
    await waitFor(() =>
      expect(callsTo(`POST /api/v1/claims/${CLAIM}/representative-appointments`)).toHaveLength(1),
    );
    expect(callsTo(`POST /api/v1/claims/${CLAIM}/representative-appointments`)[0]?.body).toEqual({
      instrumentKind: "org_form",
      formVersionId: "f1",
      representativeName: "New Person",
      representativeKind: "attorney",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Record an appointment/ })).toBeNull(),
    );
  });

  it("explains why the recorder cannot activate", async () => {
    handlers[APPTS] = listOf([appointment({ recordedByMembershipId: ME })]);
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    const button = await screen.findByRole("button", { name: "Activate appointment" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/You recorded this appointment, so a second person must activate it/);
  });

  it("offers activation to a second person and posts it with the version", async () => {
    handlers[APPTS] = listOf([appointment()]);
    handlers["POST /api/v1/representative-appointments/a1/activate"] = () =>
      json(200, { id: "a1", version: 4, validityEndPassed: false });
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    const button = await screen.findByRole("button", { name: "Activate appointment" });
    expect(button.hasAttribute("disabled")).toBe(false);
    await userEvent.click(button);
    await waitFor(() =>
      expect(callsTo("POST /api/v1/representative-appointments/a1/activate")).toHaveLength(1),
    );
  });

  it("blocks activation until the document is attached and every element confirmed", async () => {
    handlers[APPTS] = listOf([
      appointment({
        documentId: null,
        documentVersionId: null,
        elements: [{ label: "E", state: "missing" }],
      }),
    ]);
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(await screen.findByRole("button", { name: /Open appointment of/ }));
    const button = await screen.findByRole("button", { name: "Activate appointment" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/Attach the signed appointment document first/);
  });

  it("shows an absent validity end as absent and a passed typed end as a flag, never as an expiry", async () => {
    handlers[APPTS] = listOf([
      appointment({ id: "a1", state: "active", status: "active" }),
      appointment({
        id: "a2",
        representativeName: "Second Person",
        state: "active",
        status: "validity_end_passed_as_recorded",
        validThroughOn: "2026-01-02",
        validitySourceNote: "form",
      }),
    ]);
    mount(<RepresentativePanel claimId={CLAIM} canManage={false} canVerify={false} />);
    expect(
      await screen.findByText(new RegExp(VALIDITY_PASSED.replace(/[()]/g, "\\$&"))),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    expect(await screen.findByText(VALIDITY_NOT_RECORDED)).toBeTruthy();
  });

  it("keys the drawer on the appointment: opening another shows its own values", async () => {
    handlers[APPTS] = listOf([
      appointment(),
      appointment({ id: "a2", representativeName: "Second Person" }),
    ]);
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    const rail = await screen.findByLabelText("Appointment of representative", {
      selector: "aside",
    });
    expect(within(rail).getByText("Fixture Person")).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Open appointment of Second Person/ }),
    );
    await waitFor(() => expect(within(rail).getByText("Second Person")).toBeTruthy());
  });

  it("keeps the list and offers Retry when a refresh fails after a good load", async () => {
    handlers[APPTS] = listOf([appointment()]);
    const view = mount(<RepresentativePanel claimId={CLAIM} canManage canVerify refreshKey={1} />);
    await screen.findByText(/Fixture Person/);
    handlers[APPTS] = () => json(500, { error: { code: "BOOM", message: "server unavailable" } });
    view.rerender(<RepresentativePanel claimId={CLAIM} canManage canVerify refreshKey={2} />);
    expect(await screen.findByText(/could not be refreshed: server unavailable/)).toBeTruthy();
    expect(screen.getByText(/Fixture Person/)).toBeTruthy();
    handlers[APPTS] = listOf([appointment()]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
    expect(screen.getByText(/Fixture Person/)).toBeTruthy();
  });

  it("never lets a slower, older response overwrite a newer one", async () => {
    let releaseOld: (r: Response) => void = () => undefined;
    let first = true;
    handlers[APPTS] = () => {
      if (first) {
        first = false;
        return new Promise<Response>((resolve) => {
          releaseOld = resolve;
        });
      }
      return json(200, {
        claimId: CLAIM,
        patientId: "p1",
        items: [appointment({ representativeName: "Newer Person" })],
      });
    };
    const view = mount(<RepresentativePanel claimId={CLAIM} canManage canVerify refreshKey={1} />);
    await waitFor(() => expect(callsTo(APPTS)).toHaveLength(1));
    view.rerender(<RepresentativePanel claimId={CLAIM} canManage canVerify refreshKey={2} />);
    expect(await screen.findByText(/Newer Person/)).toBeTruthy();
    releaseOld(
      json(200, {
        claimId: CLAIM,
        patientId: "p1",
        items: [appointment({ representativeName: "Older Person" })],
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Older Person/)).toBeNull();
    expect(screen.getByText(/Newer Person/)).toBeTruthy();
  });

  it("keeps typed values behind a visible cue when a save hits a stale version, and reads the record again", async () => {
    handlers[APPTS] = listOf([appointment({ recordedByMembershipId: ME })]);
    handlers["PATCH /api/v1/representative-appointments/a1"] = () =>
      json(409, { error: { code: "VERSION_CONFLICT", message: "modified by another writer" } });
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    const name = (await screen.findByLabelText("Representative's name")) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, "Typed Person");
    const before = callsTo(APPTS).length;
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(CHANGED_CUE)).toBeTruthy();
    expect(screen.getByText(/modified by another writer/)).toBeTruthy();
    await waitFor(() => expect(callsTo(APPTS).length).toBeGreaterThan(before));
    expect((screen.getByLabelText("Representative's name") as HTMLInputElement).value).toBe(
      "Typed Person",
    );
  });

  it("attaches the signed document with a UUID check, sends the version id and clears the inputs", async () => {
    handlers[APPTS] = listOf([appointment({ documentId: null, documentVersionId: null })]);
    handlers["PUT /api/v1/representative-appointments/a1/document"] = ok({ id: "a1", version: 4 });
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(await screen.findByRole("button", { name: /Open appointment of/ }));
    const attach = await screen.findByRole("button", { name: "Attach document" });
    expect(attach.hasAttribute("disabled")).toBe(true);
    const docInput = screen.getByLabelText("Document ID") as HTMLInputElement;
    await userEvent.type(docInput, "not-a-uuid");
    expect(await screen.findByText("Enter the document's UUID.")).toBeTruthy();
    await userEvent.clear(docInput);
    await userEvent.type(docInput, DOC);
    await userEvent.type(screen.getByLabelText("Version ID of the uploaded copy"), VER);
    await userEvent.click(attach);
    await waitFor(() =>
      expect(callsTo("PUT /api/v1/representative-appointments/a1/document")).toHaveLength(1),
    );
    expect(callsTo("PUT /api/v1/representative-appointments/a1/document")[0]?.body).toEqual({
      documentId: DOC,
      documentVersionId: VER,
    });
    await waitFor(() => expect(docInput.value).toBe(""));
  });

  it("records a revocation with its date and note", async () => {
    handlers[APPTS] = listOf([appointment({ state: "active", status: "active" })]);
    handlers["POST /api/v1/representative-appointments/a1/revoke"] = ok({ id: "a1", version: 4 });
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(await screen.findByRole("button", { name: /Open appointment of/ }));
    const revoke = await screen.findByRole("button", { name: "Record revocation" });
    expect(revoke.hasAttribute("disabled")).toBe(true);
    setDate("Revocation received on", "2026-06-01");
    await userEvent.type(screen.getByLabelText("How it was received (note)"), "letter received");
    await userEvent.click(revoke);
    await waitFor(() =>
      expect(callsTo("POST /api/v1/representative-appointments/a1/revoke")).toHaveLength(1),
    );
    expect(callsTo("POST /api/v1/representative-appointments/a1/revoke")[0]?.body).toEqual({
      revokedOn: "2026-06-01",
      note: "letter received",
    });
  });

  it("sends a step-up refusal through /step-up and restores the typed revocation on a genuine return", async () => {
    handlers[APPTS] = listOf([appointment({ state: "active", status: "active" })]);
    handlers["POST /api/v1/representative-appointments/a1/revoke"] = () =>
      json(403, { error: { code: "STEP_UP_REQUIRED", message: "recent verification required" } });
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(await screen.findByRole("button", { name: /Open appointment of/ }));
    setDate("Revocation received on", "2026-06-01");
    await userEvent.type(
      await screen.findByLabelText("How it was received (note)"),
      "letter received",
    );
    await userEvent.click(screen.getByRole("button", { name: "Record revocation" }));
    expect(await screen.findByText("STEP-UP PAGE")).toBeTruthy();
    expect(
      Object.keys(window.sessionStorage).some((k) => k.includes("representative-revoke")),
    ).toBe(true);
    cleanup();

    // the step-up page records a one-shot return marker for the path it returns to
    markStepUpReturn("/claim");
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    expect(await screen.findByLabelText("How it was received (note)")).toBeTruthy();
    expect((screen.getByLabelText("How it was received (note)") as HTMLInputElement).value).toBe(
      "letter received",
    );
    expect((screen.getByLabelText("Revocation received on") as HTMLInputElement).value).toBe(
      "2026-06-01",
    );
  });

  it("discards an abandoned step-up draft instead of reopening the drawer on an ordinary visit", async () => {
    handlers[APPTS] = listOf([appointment({ state: "active", status: "active" })]);
    handlers["POST /api/v1/representative-appointments/a1/revoke"] = () =>
      json(403, { error: { code: "STEP_UP_REQUIRED", message: "recent verification required" } });
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await userEvent.click(await screen.findByRole("button", { name: /Open appointment of/ }));
    setDate("Revocation received on", "2026-06-01");
    await userEvent.type(await screen.findByLabelText("How it was received (note)"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Record revocation" }));
    await screen.findByText("STEP-UP PAGE");
    cleanup();
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    await screen.findByText(/Fixture Person/);
    expect(screen.queryByLabelText("How it was received (note)")).toBeNull();
    await waitFor(() =>
      expect(Object.keys(window.sessionStorage).some((k) => k.includes("representative-"))).toBe(
        false,
      ),
    );
  });
});

describe("BeneficiaryAppealPanel", () => {
  const manage = (props: Partial<Parameters<typeof BeneficiaryAppealPanel>[0]> = {}) => (
    <BeneficiaryAppealPanel claimId={CLAIM} canManage canReadAppointments {...props} />
  );

  it("lists a representative-filed appeal flagged none on file, with the persistent 'records, does not file' note and no invented date", async () => {
    handlers[APPEALS] = listOf([appeal()]);
    mount(manage());
    expect(await screen.findByText(/Representative: None On File/)).toBeTruthy();
    expect(screen.getByText(RECORDS_NOT_FILES)).toBeTruthy();
    expect(screen.getByText(/filed date not recorded/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Open beneficiary appeal/ }));
    expect(await screen.findByText(NO_DUE_DATE_ENTER)).toBeTruthy();
    expect(screen.getByText(NO_APPOINTMENT)).toBeTruthy();
  });

  it("keeps what was typed and shows the 'record changed' cue when a save hits a stale version", async () => {
    handlers[APPEALS] = listOf([appeal()]);
    handlers["PATCH /api/v1/beneficiary-appeals/b1"] = () =>
      json(409, { error: { code: "VERSION_CONFLICT", message: "modified by another writer" } });
    mount(manage());
    await userEvent.click(await screen.findByRole("button", { name: /Open beneficiary appeal/ }));
    const note = (await screen.findByLabelText(
      "How the hospice learned of it",
    )) as HTMLInputElement;
    await userEvent.clear(note);
    await userEvent.type(note, "typed value");
    const before = callsTo(APPEALS).length;
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(CHANGED_CUE)).toBeTruthy();
    await waitFor(() => expect(callsTo(APPEALS).length).toBeGreaterThan(before));
    expect((screen.getByLabelText("How the hospice learned of it") as HTMLInputElement).value).toBe(
      "typed value",
    );
  });

  it("keeps the list when a refresh fails after a good load, and Retry brings it back clean", async () => {
    handlers[APPEALS] = listOf([appeal()]);
    const view = mount(manage({ refreshKey: 1 }));
    await screen.findByText(/Representative: None On File/);
    handlers[APPEALS] = () => json(500, { error: { code: "BOOM", message: "server unavailable" } });
    view.rerender(manage({ refreshKey: 2 }));
    expect(await screen.findByText(/could not be refreshed: server unavailable/)).toBeTruthy();
    expect(screen.getByText(/Representative: None On File/)).toBeTruthy();
    handlers[APPEALS] = listOf([appeal()]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/could not be refreshed/)).toBeNull());
  });

  it("shows only Retry when the first load fails", async () => {
    handlers[APPEALS] = () => json(500, { error: { code: "BOOM", message: "server unavailable" } });
    mount(manage());
    expect(await screen.findByText(/Beneficiary appeals unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("asks before closing a record or recording a withdrawal", async () => {
    handlers[APPEALS] = listOf([appeal({ state: "decided", outcomeLabel: "favorable" })]);
    handlers["POST /api/v1/beneficiary-appeals/b1/state"] = ok({ id: "b1", version: 3 });
    mount(manage());
    await userEvent.click(await screen.findByRole("button", { name: /Open beneficiary appeal/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Close record" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/can no longer be edited/)).toBeTruthy();
    expect(callsTo("POST /api/v1/beneficiary-appeals/b1/state")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close record" }));
    await userEvent.click(await screen.findByRole("button", { name: "Yes, close the record" }));
    await waitFor(() =>
      expect(callsTo("POST /api/v1/beneficiary-appeals/b1/state")).toHaveLength(1),
    );
    expect(callsTo("POST /api/v1/beneficiary-appeals/b1/state")[0]?.body).toEqual({
      move: "close",
    });
  });

  it("the withdrawal is confirmed too", async () => {
    handlers[APPEALS] = listOf([appeal()]);
    mount(manage());
    await userEvent.click(await screen.findByRole("button", { name: /Open beneficiary appeal/ }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Withdrawn by the beneficiary" }),
    );
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(callsTo("POST /api/v1/beneficiary-appeals/b1/state")).toHaveLength(0);
  });

  it("the intake form starts at 'Choose...', blocks with a reason, and records only what was typed", async () => {
    handlers[`POST /api/v1/claims/${CLAIM}/beneficiary-appeals`] = () =>
      json(201, { id: "b9", version: 1 });
    mount(manage());
    await userEvent.click(
      await screen.findByRole("button", { name: "Record a beneficiary-filed appeal" }),
    );
    expect((screen.getByLabelText("Filed by") as HTMLSelectElement).value).toBe("");
    expect(
      (screen.getByLabelText("Level (as the notice names it)") as HTMLSelectElement).value,
    ).toBe("");
    const submit = screen.getByRole("button", { name: "Record appeal" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(submit.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/Choose who filed/);
    await pick("Filed by", "beneficiary");
    await pick("Level (as the notice names it)", "reconsideration");
    await userEvent.type(screen.getByLabelText("How the hospice learned of it"), "heard by phone");
    await userEvent.click(submit);
    await waitFor(() =>
      expect(callsTo(`POST /api/v1/claims/${CLAIM}/beneficiary-appeals`)).toHaveLength(1),
    );
    expect(callsTo(`POST /api/v1/claims/${CLAIM}/beneficiary-appeals`)[0]?.body).toEqual({
      filerKind: "beneficiary",
      tierLabel: "reconsideration",
      sourceNote: "heard by phone",
    });
  });

  it("a representative intake waits for the appointments, blocks 'unlinked' when they fail to load, and offers Retry", async () => {
    handlers[APPTS] = () => json(500, { error: { code: "BOOM", message: "appointments down" } });
    mount(manage());
    await userEvent.click(
      await screen.findByRole("button", { name: "Record a beneficiary-filed appeal" }),
    );
    await pick("Filed by", "representative");
    await pick("Level (as the notice names it)", "alj");
    await userEvent.type(screen.getByLabelText("How the hospice learned of it"), "heard");
    expect(await screen.findByText(/Appointments unavailable: appointments down/)).toBeTruthy();
    const submit = screen.getByRole("button", { name: "Record appeal" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    handlers[APPTS] = listOf([appointment({ state: "active", status: "active" })]);
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record appeal" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    expect(screen.getByRole("option", { name: /Fixture Person/ })).toBeTruthy();
  });
});

describe("RepresentativeFormSettings", () => {
  it("with none entered says no form is configured and ships nothing", async () => {
    mount(<RepresentativeFormSettings />, ["representative_form.configure"]);
    expect(await screen.findByText(NO_FORM_CONFIGURED)).toBeTruthy();
    expect(screen.getByText(/ships none/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add a form version" }));
    expect(
      (await screen.findByRole("button", { name: "Save form version" })).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("saves a version exactly as typed, one element per line", async () => {
    handlers["POST /api/v1/representative-form-versions"] = () =>
      json(201, { id: "f9", version: 1 });
    mount(<RepresentativeFormSettings />, ["representative_form.configure"]);
    await userEvent.click(await screen.findByRole("button", { name: "Add a form version" }));
    await userEvent.type(screen.getByLabelText("Name (your organization's label)"), "Org form A");
    await userEvent.type(
      screen.getByLabelText("Source note (who supplied it, and where)"),
      "compliance binder",
    );
    await userEvent.type(screen.getByLabelText("Required elements, one per line"), "one{enter}two");
    await userEvent.click(screen.getByRole("button", { name: "Save form version" }));
    await waitFor(() =>
      expect(callsTo("POST /api/v1/representative-form-versions")).toHaveLength(1),
    );
    expect(callsTo("POST /api/v1/representative-form-versions")[0]?.body).toEqual({
      label: "Org form A",
      sourceNote: "compliance binder",
      requiredElements: ["one", "two"],
    });
  });
});
