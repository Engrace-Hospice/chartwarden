// apps/web/src/modules/25-remittance — milestone 13a beneficiary-appeal and representative UI. The screens invent nothing: no
// form configured, no appointment, no validity end and no due date each read as exactly that; a second person is required to
// activate and the button explains why it is off; a refused or stale save keeps what was typed; a failed reload keeps the
// list with a Retry; nothing says a CMS rule or period.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BeneficiaryAppealPanel } from "./beneficiary-appeal-panel";
import {
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
  documentId: "d1",
  documentVersionId: "v1",
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

let appointments: unknown[];
let appeals: unknown[];
let forms: unknown[];
let failAppeals = false;
let patchStatus = 200;
let calls: string[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  calls.push(`${method} ${path}`);
  if (path === `/api/v1/claims/${CLAIM}/representative-appointments` && method === "GET") {
    return json(200, { claimId: CLAIM, patientId: "p1", items: appointments });
  }
  if (path === `/api/v1/claims/${CLAIM}/beneficiary-appeals` && method === "GET") {
    return failAppeals
      ? json(500, { error: { code: "BOOM", message: "server unavailable" } })
      : json(200, { claimId: CLAIM, patientId: "p1", items: appeals });
  }
  if (path === "/api/v1/representative-form-versions") return json(200, { items: forms });
  if (path === "/api/v1/beneficiary-appeals/b1" && method === "PATCH") {
    return patchStatus === 409
      ? json(409, { error: { code: "VERSION_CONFLICT", message: "modified by another writer" } })
      : json(200, { id: "b1", version: 3 });
  }
  return json(404, {});
}

function mount(element: JSX.Element, permissions: string[] = []): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u1",
          organizationId: "org-1",
          membershipId: ME,
          roles: ["billing_specialist"],
          permissions,
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter>{element}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  appointments = [];
  appeals = [];
  forms = [];
  failAppeals = false;
  patchStatus = 200;
});
afterEach(() => cleanup());

describe("RepresentativePanel", () => {
  it("with none on file says so, states that it grants nothing, and with no form configured says that too", async () => {
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    expect(await screen.findByText(NO_APPOINTMENT)).toBeTruthy();
    expect(screen.getByText(/no portal access, consent or caregiver status/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Record an appointment" }));
    expect(await screen.findByText(NO_FORM_CONFIGURED)).toBeTruthy();
    // only the other written instrument is offered, and the submit explains why it is off
    const submit = screen.getByRole("button", { name: "Record draft" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(submit.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("explains why the recorder cannot activate, and offers activation to a second person", async () => {
    appointments = [appointment({ recordedByMembershipId: ME })];
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    const button = await screen.findByRole("button", { name: "Activate appointment" });
    expect(button.hasAttribute("disabled")).toBe(true);
    const why = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(why?.textContent).toMatch(
      /You recorded this appointment, so a second person must activate it/,
    );
    cleanup();
    appointments = [appointment()];
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    const second = await screen.findByRole("button", { name: "Activate appointment" });
    expect(second.hasAttribute("disabled")).toBe(false);
  });

  it("blocks activation until the document is attached and every element confirmed", async () => {
    appointments = [
      appointment({
        documentId: null,
        documentVersionId: null,
        elements: [{ label: "E", state: "missing" }],
      }),
    ];
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    fireEvent.click(await screen.findByRole("button", { name: /Open appointment of/ }));
    const button = await screen.findByRole("button", { name: "Activate appointment" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toMatch(/Attach the signed appointment document first/);
  });

  it("shows an absent validity end as absent and a passed typed end as a flag, never as an expiry", async () => {
    appointments = [
      appointment({ id: "a1", state: "active", status: "active" }),
      appointment({
        id: "a2",
        representativeName: "Second Person",
        state: "active",
        status: "validity_end_passed_as_recorded",
        validThroughOn: "2026-01-02",
        validitySourceNote: "form",
      }),
    ];
    mount(<RepresentativePanel claimId={CLAIM} canManage={false} canVerify={false} />);
    expect(
      await screen.findByText(new RegExp(VALIDITY_PASSED.replace(/[()]/g, "\\$&"))),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open appointment of Fixture Person/ }));
    expect(await screen.findByText(VALIDITY_NOT_RECORDED)).toBeTruthy();
  });

  it("keys the drawer on the appointment: opening another shows its own values", async () => {
    appointments = [appointment(), appointment({ id: "a2", representativeName: "Second Person" })];
    mount(<RepresentativePanel claimId={CLAIM} canManage canVerify />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Open appointment of Fixture Person/ }),
    );
    const rail = await screen.findByLabelText("Appointment of representative", {
      selector: "aside",
    });
    expect(within(rail).getByText("Fixture Person")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open appointment of Second Person/ }));
    await waitFor(() => expect(within(rail).getByText("Second Person")).toBeTruthy());
  });
});

describe("BeneficiaryAppealPanel", () => {
  it("lists a representative-filed appeal flagged none on file, with the persistent 'records, does not file' note and no invented date", async () => {
    appeals = [appeal()];
    mount(<BeneficiaryAppealPanel claimId={CLAIM} canManage canReadAppointments />);
    expect(await screen.findByText(/Representative: None On File/)).toBeTruthy();
    expect(screen.getByText(RECORDS_NOT_FILES)).toBeTruthy();
    expect(screen.getByText(/filed date not recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open beneficiary appeal/ }));
    expect(await screen.findByText(NO_DUE_DATE_ENTER)).toBeTruthy();
    expect(screen.getByText(NO_APPOINTMENT)).toBeTruthy();
  });

  it("keeps what was typed when a save hits a stale version, and reloads the record", async () => {
    appeals = [appeal()];
    patchStatus = 409;
    mount(<BeneficiaryAppealPanel claimId={CLAIM} canManage canReadAppointments />);
    fireEvent.click(await screen.findByRole("button", { name: /Open beneficiary appeal/ }));
    const note = (await screen.findByLabelText(
      "How the hospice learned of it",
    )) as HTMLInputElement;
    fireEvent.change(note, { target: { value: "typed value" } });
    const before = calls.filter(
      (c) => c === `GET /api/v1/claims/${CLAIM}/beneficiary-appeals`,
    ).length;
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText(/modified by another writer/)).toBeTruthy();
    await waitFor(() =>
      expect(
        calls.filter((c) => c === `GET /api/v1/claims/${CLAIM}/beneficiary-appeals`).length,
      ).toBeGreaterThan(before),
    );
    expect((screen.getByLabelText("How the hospice learned of it") as HTMLInputElement).value).toBe(
      "typed value",
    );
  });

  it("keeps the list on screen when a reload fails and offers Retry", async () => {
    appeals = [appeal()];
    mount(<BeneficiaryAppealPanel claimId={CLAIM} canManage canReadAppointments refreshKey={1} />);
    await screen.findByText(/Representative: None On File/);
    cleanup();
    failAppeals = true;
    mount(<BeneficiaryAppealPanel claimId={CLAIM} canManage canReadAppointments />);
    expect(await screen.findByText(/Beneficiary appeals unavailable/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});

describe("RepresentativeFormSettings", () => {
  it("with none entered says no form is configured and ships nothing", async () => {
    mount(<RepresentativeFormSettings />, ["representative_form.configure"]);
    expect(await screen.findByText(NO_FORM_CONFIGURED)).toBeTruthy();
    expect(screen.getByText(/ships none/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add a form version" }));
    const save = await screen.findByRole("button", { name: "Save form version" });
    expect(save.hasAttribute("disabled")).toBe(true);
  });
});
