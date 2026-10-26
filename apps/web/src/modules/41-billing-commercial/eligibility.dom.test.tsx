// The eligibility view (M41): patient-first reads, the server's freshness verdict shown as-is, error states (404 is an error, never
// "no checks" or a pass), stale-while-revalidate, write/manage gating, running a check (idempotency, double submit, refusals in our own
// words, replayed answers), and the plan policy drawer with its step-up round trip. Synthetic data only; no member id anywhere.
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markStepUpReturn } from "../../shell/step-up-redirect";
import { localToday } from "./commercial-model";
import {
  type Call,
  ENTITY_ID,
  PATIENT_ID,
  PLAN_ID,
  type Responder,
  eligibilityRow,
  entitiesRoute,
  freshnessBody,
  latestBody,
  mountScreen,
  patientRoute,
  planRow,
} from "./commercial-test-harness";
import { CommercialEligibility } from "./eligibility";

const PATH = "/commercial/billing/eligibility";
const HISTORY = "GET /api/v1/billing/commercial/eligibility";
const LATEST = "GET /api/v1/billing/commercial/eligibility/latest";
const CHECK = "POST /api/v1/billing/commercial/eligibility/check";
const POLICY = `PATCH /api/v1/billing/commercial/payer-plans/${PLAN_ID}/eligibility-policy`;
const BASE = `${PATH}?entity=${ENTITY_ID}&patient=${PATIENT_ID}`;
const WITH_PLAN = `${BASE}&plan=${PLAN_ID}`;
const WRITE = ["commercial_billing.read", "commercial_billing.write"];
const MANAGE = ["commercial_billing.read", "commercial_billing.manage_enrollment"];
const OTHER_PATIENT = "99999999-9999-4999-8999-999999999999";
const VENDOR_TEXT = "LEAKED-VENDOR-REASON-TEXT";

function GoTo({ search }: { search: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`${PATH}?${search}`)}>
      go
    </button>
  );
}

interface Opts {
  history?: Responder;
  latest?: Responder;
  check?: Responder;
  policy?: Responder;
  permissions?: string[];
  entry?: string;
  calls?: Call[];
  goTo?: string;
  plans?: Responder;
  entities?: Responder;
}

const historyOk =
  (items: Record<string, unknown>[] = [eligibilityRow()]): Responder =>
  () => ({ body: { items } });
const latestOk: Responder = () => ({ body: latestBody() });
const refuse = (status: number, code: string): Responder => {
  return () => ({ status, body: { error: { code, message: VENDOR_TEXT } } });
};

function mount(opts: Opts = {}): ReturnType<typeof mountScreen> {
  return mountScreen({
    routes: {
      "GET /api/v1/provider-entities": opts.entities ?? entitiesRoute,
      "GET /api/v1/billing/commercial/payer-plans":
        opts.plans ??
        (() => ({
          body: { items: [planRow(), planRow({ id: "p2", planName: "Synthetic HMO" })] },
        })),
      [HISTORY]: opts.history ?? historyOk(),
      [LATEST]: opts.latest ?? latestOk,
      [CHECK]:
        opts.check ??
        (() => ({ body: { ...eligibilityRow(), replayed: false, freshness: freshnessBody() } })),
      [POLICY]:
        opts.policy ??
        (() => ({
          body: {
            id: PLAN_ID,
            payerId: "x",
            eligibilityStalenessPolicy: "block",
            eligibilityMaxAgeDays: 14,
          },
        })),
      [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute,
    },
    calls: opts.calls ?? [],
    element: (
      <>
        <CommercialEligibility />
        {opts.goTo ? <GoTo search={opts.goTo} /> : null}
      </>
    ),
    routePath: PATH,
    entry: opts.entry ?? WITH_PLAN,
    permissions: opts.permissions ?? ["commercial_billing.read"],
  });
}

const writes = (calls: Call[]): Call[] => calls.filter((c) => c.method !== "GET");
const reads = (calls: Call[], path: string): Call[] =>
  calls.filter((c) => c.method === "GET" && c.path === path);
const checkForm = (): HTMLFormElement =>
  screen.getByRole("form", { name: "Run eligibility check" }) as HTMLFormElement;
const policyDrawer = (): Promise<HTMLElement> =>
  screen.findByLabelText("Edit eligibility policy", { selector: "aside" });

beforeEach(() => window.sessionStorage.clear());
afterEach(cleanup);

describe("CommercialEligibility reads", () => {
  it("starts at a patient search and reads nothing until a patient is chosen", async () => {
    const calls: Call[] = [];
    mount({ entry: `${PATH}?entity=${ENTITY_ID}`, calls });
    await screen.findByText("Choose a patient");
    await new Promise((r) => setTimeout(r, 30));
    expect(reads(calls, "/api/v1/billing/commercial/eligibility")).toHaveLength(0);
    expect(reads(calls, "/api/v1/billing/commercial/eligibility/latest")).toHaveLength(0);
  });

  it("shows the latest check with the server's verdict and the history, newest first", async () => {
    const calls: Call[] = [];
    mount({
      calls,
      history: historyOk([
        eligibilityRow({ id: "c2", serviceDate: "2026-10-20" }),
        eligibilityRow({ id: "c1", serviceDate: "2026-09-01", outcome: "inactive" }),
      ]),
    });
    const card = await screen.findByLabelText("Latest eligibility check for Synthetic PPO");
    expect(within(card).getByText("Fresh")).toBeTruthy();
    expect(within(card).getByText("Eligibility was verified recently.")).toBeTruthy();
    expect(within(card).getByText("1 days old; stale after 30 days")).toBeTruthy();
    expect(within(card).getByText("Warns only")).toBeTruthy();
    expect(within(card).getByText("Active")).toBeTruthy();
    expect(within(card).getByText("2026-10-24 10:00 UTC")).toBeTruthy();

    const table = await screen.findByRole("table", {
      name: /Eligibility checks for .* newest first/,
    });
    for (const h of within(table).getAllByRole("columnheader")) {
      expect(h.getAttribute("scope")).toBe("col");
    }
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]?.textContent).toContain("2026-10-20");
    expect(rows[1]?.textContent).toContain("2026-09-01");
    expect(rows[1]?.textContent).toContain("Inactive");

    const history = reads(calls, "/api/v1/billing/commercial/eligibility")[0];
    expect(history?.query.get("providerEntityId")).toBe(ENTITY_ID);
    expect(history?.query.get("patientId")).toBe(PATIENT_ID);
    expect(history?.query.get("planId")).toBe(PLAN_ID);
    const latest = reads(calls, "/api/v1/billing/commercial/eligibility/latest")[0];
    expect(latest?.query.get("planId")).toBe(PLAN_ID);
  });

  it("with all plans chosen, reads the whole history and asks for a plan before showing a verdict", async () => {
    const calls: Call[] = [];
    mount({ calls, entry: BASE });
    await screen.findByText("Choose a plan");
    await screen.findByRole("table");
    expect(reads(calls, "/api/v1/billing/commercial/eligibility")[0]?.query.has("planId")).toBe(
      false,
    );
    expect(reads(calls, "/api/v1/billing/commercial/eligibility/latest")).toHaveLength(0);
  });

  it.each([
    [
      "missing",
      latestBody(
        null,
        freshnessBody({
          status: "missing",
          severity: "warning",
          message: "No eligibility check is on record.",
          evidence: {
            ageDays: null,
            maxAgeDays: 30,
            policy: "warn",
            outcome: null,
            checkedAt: null,
          },
        }),
      ),
      [
        "No check on record",
        "No eligibility check is on record.",
        "No check is on record for this plan.",
      ],
    ],
    [
      "stale",
      latestBody(
        undefined,
        freshnessBody({
          status: "stale",
          severity: "block",
          message: "The last check is too old.",
          evidence: {
            ageDays: 45,
            maxAgeDays: 30,
            policy: "block",
            outcome: "active",
            checkedAt: "2026-09-10T10:00:00.000Z",
          },
        }),
      ),
      [
        "Stale",
        "The last check is too old.",
        "45 days old; stale after 30 days",
        "Blocks the claim",
      ],
    ],
    [
      "unverified",
      latestBody(
        undefined,
        freshnessBody({
          status: "unverified",
          severity: "warning",
          message: "The answer could not be read.",
        }),
      ),
      ["Unverified", "The answer could not be read."],
    ],
  ])("shows a %s verdict as a real state, never blank", async (_name, body, texts) => {
    mount({ latest: () => ({ body }) });
    const card = await screen.findByLabelText("Latest eligibility check for Synthetic PPO");
    for (const t of texts as string[]) expect(within(card).getByText(t)).toBeTruthy();
  });

  it("shows a 404 on either read as an error with retry, never as none or a pass", async () => {
    const notFound: Responder = () => ({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    mount({ history: notFound, latest: notFound });
    await screen.findByText("Check history unavailable");
    await screen.findByText("Latest check unavailable");
    expect(screen.queryByText("No checks recorded")).toBeNull();
    expect(screen.queryByText("Fresh")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(2);
  });

  it("recovers on Try again", async () => {
    let n = 0;
    mount({
      history: () => {
        n += 1;
        return n === 1 ? { status: 500, body: {} } : { body: { items: [eligibilityRow()] } };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("table");
  });

  it("says plainly when no check is recorded", async () => {
    mount({ history: historyOk([]) });
    await screen.findByText("No checks recorded");
  });

  it("keeps the previous rows with an alert when a reload of the same scope fails", async () => {
    let n = 0;
    mount({
      permissions: WRITE,
      history: () => {
        n += 1;
        return n === 2 ? { status: 500, body: {} } : { body: { items: [eligibilityRow()] } };
      },
    });
    await screen.findByRole("table");
    fireEvent.submit(checkForm());
    await screen.findByText(/check history could not be reloaded/);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.queryByText("Check history unavailable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByText(/could not be reloaded/)).toBeNull());
  });

  it("keeps rows mounted during a same-scope reload, and shows no other scope's rows while another loads", async () => {
    let n = 0;
    let release: (() => void) | undefined;
    mount({
      permissions: WRITE,
      goTo: `entity=${ENTITY_ID}&patient=${OTHER_PATIENT}&plan=${PLAN_ID}`,
      history: (call) => {
        if (call.query.get("patientId") === OTHER_PATIENT) {
          return new Promise((resolve) => {
            release = () => resolve({ body: { items: [] } });
          });
        }
        n += 1;
        if (n === 1) return { body: { items: [eligibilityRow()] } };
        return new Promise((resolve) => {
          release = () => resolve({ body: { items: [eligibilityRow({ outcome: "unknown" })] } });
        });
      },
    });
    await screen.findByRole("table");
    fireEvent.submit(checkForm()); // a same-scope reload
    await waitFor(() => expect(release).toBeDefined());
    expect(screen.getByRole("table")).toBeTruthy(); // rows stay mounted
    release?.();
    await within(screen.getByRole("table")).findByText("Unknown");

    release = undefined;
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(screen.queryByRole("table")).toBeNull(); // the old patient's rows are gone at once
    await waitFor(() => expect(release).toBeDefined());
    (release as (() => void) | undefined)?.();
    await screen.findByText("No checks recorded");
  });

  it("carries no member id in the page or in any request", async () => {
    const calls: Call[] = [];
    mount({ permissions: [...WRITE, "commercial_billing.manage_enrollment"], calls });
    await screen.findByRole("table");
    fireEvent.submit(checkForm());
    await screen.findByText("Eligibility check recorded.");
    expect(document.body.textContent).not.toMatch(/member\s*id|memberId|subscriber/i);
    const sent = JSON.stringify(calls.map((c) => [c.path, c.query.toString(), c.body]));
    expect(sent).not.toMatch(/member|subscriber/i);
  });
});

describe("CommercialEligibility gating", () => {
  it("hides Run check and Edit policy without write / manage_enrollment", async () => {
    mount();
    await screen.findByRole("table");
    expect(screen.queryByRole("form", { name: "Run eligibility check" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit eligibility policy" })).toBeNull();
  });

  it("shows Run check with write and Edit policy with manage_enrollment, only when applicable", async () => {
    mount({ permissions: WRITE });
    await screen.findByRole("table");
    expect(checkForm()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit eligibility policy" })).toBeNull();
    cleanup();
    mount({ permissions: MANAGE });
    await screen.findByRole("button", { name: "Edit eligibility policy" });
    expect(screen.queryByRole("form", { name: "Run eligibility check" })).toBeNull();
    cleanup();
    mount({ permissions: MANAGE, entry: BASE }); // no plan chosen: nothing to edit
    await screen.findByText("Choose a plan");
    expect(screen.queryByRole("button", { name: "Edit eligibility policy" })).toBeNull();
  });
});

describe("CommercialEligibility run a check", () => {
  it("posts the plan, patient and a service date defaulting to today with an Idempotency-Key, and announces it", async () => {
    const calls: Call[] = [];
    mount({ permissions: WRITE, calls });
    await screen.findByRole("table");
    expect((screen.getByLabelText(/Service date/) as HTMLInputElement).value).toBe(localToday());
    fireEvent.submit(checkForm());
    await screen.findByText("Eligibility check recorded.");
    const [post] = writes(calls);
    expect(post?.body).toEqual({
      providerEntityId: ENTITY_ID,
      patientId: PATIENT_ID,
      planId: PLAN_ID,
      serviceDate: localToday(),
    });
    expect(post?.headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() =>
      expect(reads(calls, "/api/v1/billing/commercial/eligibility/latest").length).toBeGreaterThan(
        1,
      ),
    );
  });

  it("announces a replayed result as the earlier answer, not a new check", async () => {
    mount({
      permissions: WRITE,
      check: () => ({ body: { ...eligibilityRow(), replayed: true, freshness: freshnessBody() } }),
    });
    await screen.findByRole("table");
    fireEvent.submit(checkForm());
    await screen.findByText(/earlier result, not a new check/);
    expect(screen.queryByText("Eligibility check recorded.")).toBeNull();
  });

  it("requires a plan and a service date before sending", async () => {
    const calls: Call[] = [];
    mount({ permissions: WRITE, calls, entry: BASE });
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText(/Service date/), { target: { value: "" } });
    fireEvent.submit(checkForm());
    await screen.findByText("Choose a plan.");
    expect(screen.getByText("Enter the service date.")).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it("sends once for a double submit", async () => {
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    mount({
      permissions: WRITE,
      calls,
      check: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ body: { ...eligibilityRow(), replayed: false, freshness: freshnessBody() } });
        }),
    });
    await screen.findByRole("table");
    fireEvent.submit(checkForm());
    fireEvent.submit(checkForm());
    await waitFor(() => expect(release).toBeDefined());
    expect(writes(calls)).toHaveLength(1);
    release?.();
    await screen.findByText("Eligibility check recorded.");
  });

  it.each([
    [503, "CH_NOT_WIRED", /cannot run commercial eligibility checks yet\. Nothing was sent/],
    [503, "COMMERCIAL_ELIGIBILITY_UNAVAILABLE", /could not answer.*Nothing was recorded/],
    [409, "COMMERCIAL_PROVIDER_NOT_ENROLLED", /not enrolled with the payer.*Nothing was sent/],
    [409, "COMMERCIAL_PAYER_NOT_ROUTED", /no clearinghouse route.*Nothing was sent/],
    [409, "COMMERCIAL_PROVIDER_NPI_MISSING", /no NPI on file.*Nothing was sent/],
    [422, "COMMERCIAL_COVERAGE_NOT_FOUND", /no coverage with this plan's payer.*Nothing was sent/],
    [422, "COMMERCIAL_ELIGIBILITY_REJECTED", /clearinghouse refused the request/],
    [409, "IDEMPOTENCY_CONFLICT", /clashed with an earlier one/],
    [404, "NOT_FOUND", /not in your scope/],
    [500, "INTERNAL", /did not go through/],
  ])(
    "maps %s %s to our own words, leaves the previous result visible and never echoes server text",
    async (status, code, words) => {
      mount({ permissions: WRITE, check: refuse(status, code) });
      await screen.findByRole("table");
      fireEvent.submit(checkForm());
      await screen.findByText(words);
      expect(document.body.textContent).not.toContain(VENDOR_TEXT);
      expect(screen.getByRole("table")).toBeTruthy();
      expect(screen.getByLabelText("Latest eligibility check for Synthetic PPO")).toBeTruthy();
      expect(screen.queryByText("Eligibility check recorded.")).toBeNull();
    },
  );

  it("links a not-enrolled refusal to the enrollments screen for this entity", async () => {
    mount({ permissions: WRITE, check: refuse(409, "COMMERCIAL_PROVIDER_NOT_ENROLLED") });
    await screen.findByRole("table");
    fireEvent.submit(checkForm());
    const link = await screen.findByRole("link", { name: "Open enrollments" });
    expect(link.getAttribute("href")).toBe(
      `/commercial/billing/enrollments?entity=${encodeURIComponent(ENTITY_ID)}`,
    );
  });

  it("keeps the Idempotency-Key on retry, drops it on a field change, a 409 and success", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount({
      permissions: WRITE,
      calls,
      check: () => {
        n += 1;
        if (n <= 2)
          return { status: 503, body: { error: { code: "COMMERCIAL_ELIGIBILITY_UNAVAILABLE" } } };
        if (n === 3) return { status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT" } } };
        return { body: { ...eligibilityRow(), replayed: false, freshness: freshnessBody() } };
      },
    });
    await screen.findByRole("table");
    const keys = (): (string | null)[] =>
      writes(calls).map((c) => c.headers.get("Idempotency-Key"));
    fireEvent.submit(checkForm());
    await screen.findByText(/Nothing was recorded/);
    fireEvent.submit(checkForm());
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(keys()[1]).toBe(keys()[0]); // retry of the same body: same key
    await screen.findByText(/Nothing was recorded/);
    fireEvent.change(screen.getByLabelText(/Service date/), { target: { value: "2026-10-01" } });
    fireEvent.submit(checkForm());
    await screen.findByText(/clashed with an earlier one/);
    expect(keys()[2]).not.toBe(keys()[1]); // a field changed: new key
    fireEvent.submit(checkForm());
    await screen.findByText("Eligibility check recorded.");
    expect(keys()[3]).not.toBe(keys()[2]); // after the 409: new key
    fireEvent.submit(checkForm());
    await waitFor(() => expect(writes(calls)).toHaveLength(5));
    expect(keys()[4]).not.toBe(keys()[3]); // after success: new key
  });
});

describe("CommercialEligibility policy drawer", () => {
  const open = async (): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByRole("button", { name: "Edit eligibility policy" }));
    return policyDrawer();
  };
  const fill = (drawer: HTMLElement, days: string, policy = "block"): void => {
    fireEvent.change(within(drawer).getByLabelText(/When the latest check/), {
      target: { value: policy },
    });
    fireEvent.change(within(drawer).getByLabelText(/Stale after/), { target: { value: days } });
  };

  it("starts from the plan's policy and saves it, announcing and reloading the verdict", async () => {
    const calls: Call[] = [];
    mount({ permissions: MANAGE, calls });
    const drawer = await open();
    expect((within(drawer).getByLabelText(/Stale after/) as HTMLInputElement).value).toBe("30");
    fill(drawer, "14");
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await screen.findByText("Eligibility policy updated.");
    const [patch] = writes(calls);
    expect(patch?.body).toEqual({ policy: "block", maxAgeDays: 14 });
    expect(patch?.headers.get("Idempotency-Key")).toBeTruthy();
    await waitFor(() => expect(policyDrawerGone()).toBe(true));
    expect(document.activeElement).not.toBe(document.body);
    await waitFor(() =>
      expect(reads(calls, "/api/v1/billing/commercial/eligibility/latest").length).toBeGreaterThan(
        1,
      ),
    );
  });

  const policyDrawerGone = (): boolean =>
    screen.queryByLabelText("Edit eligibility policy", { selector: "aside" }) === null;

  it.each(["0", "366", "1.5", "abc", ""])("rejects %j days without sending", async (days) => {
    const calls: Call[] = [];
    mount({ permissions: MANAGE, calls });
    const drawer = await open();
    fill(drawer, days);
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await within(drawer).findByText(/whole number of days from 1 to 365/);
    expect(writes(calls)).toHaveLength(0);
  });

  it("accepts the bounds 1 and 365", async () => {
    const calls: Call[] = [];
    mount({ permissions: MANAGE, calls });
    const drawer = await open();
    fill(drawer, "365", "warn");
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await screen.findByText("Eligibility policy updated.");
    expect((writes(calls)[0]?.body as { maxAgeDays: number }).maxAgeDays).toBe(365);
  });

  it("keeps a server refusal visible in fixed words, without the server's text", async () => {
    mount({ permissions: MANAGE, policy: refuse(422, "VALIDATION_ERROR") });
    const drawer = await open();
    fireEvent.submit(drawer.querySelector("form") as HTMLFormElement);
    await within(drawer).findByText(/were not accepted/);
    expect(document.body.textContent).not.toContain(VENDOR_TEXT);
    expect(policyDrawerGone()).toBe(false);
  });

  it("round-trips through step-up: draft restored on return, one save only on the user's submit, returnTo carries the entity", async () => {
    const calls: Call[] = [];
    const entry = `${PATH}?patient=${PATIENT_ID}&plan=${PLAN_ID}&policy=edit`; // no entity in the URL
    const returnTo = `${entry}&entity=${ENTITY_ID}`;
    let ceremonyDone = false;
    const policy: Responder = () =>
      ceremonyDone
        ? {
            body: {
              id: PLAN_ID,
              payerId: "x",
              eligibilityStalenessPolicy: "block",
              eligibilityMaxAgeDays: 14,
            },
          }
        : { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
    mount({ permissions: MANAGE, calls, entry, policy });
    fill(await policyDrawer(), "14");
    fireEvent.submit((await policyDrawer()).querySelector("form") as HTMLFormElement);
    await screen.findByText("elsewhere");
    expect(document.body.dataset.where).toBe(`/step-up?returnTo=${encodeURIComponent(returnTo)}`);
    expect(writes(calls)).toHaveLength(1);
    cleanup();

    ceremonyDone = true;
    markStepUpReturn(returnTo);
    mount({ permissions: MANAGE, calls, entry: returnTo, policy });
    const back = await policyDrawer();
    expect((within(back).getByLabelText(/Stale after/) as HTMLInputElement).value).toBe("14");
    await new Promise((r) => setTimeout(r, 30));
    expect(writes(calls)).toHaveLength(1); // nothing re-sent by itself
    fireEvent.submit(back.querySelector("form") as HTMLFormElement);
    await screen.findByText("Eligibility policy updated.");
    expect(writes(calls)).toHaveLength(2);
    expect(Object.keys(window.sessionStorage).some((k) => k.startsWith("wx.step-up-draft:"))).toBe(
      false,
    );
  });

  async function stashedDraft(entry: string, extra: Partial<Opts> = {}): Promise<void> {
    const stepUp: Responder = () => ({
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED" } },
    });
    mount({ permissions: MANAGE, entry, policy: stepUp, ...extra });
    fill(await policyDrawer(), "14");
    fireEvent.submit((await policyDrawer()).querySelector("form") as HTMLFormElement);
    await screen.findByText("elsewhere");
    expect(Object.keys(window.sessionStorage).some((k) => k.startsWith("wx.step-up-draft:"))).toBe(
      true,
    );
    cleanup();
  }
  const draftKept = (): boolean =>
    Object.keys(window.sessionStorage).some((k) => k.startsWith("wx.step-up-draft:"));

  it("discards a stale draft on an ordinary visit (no step-up return marker)", async () => {
    const entry = `${WITH_PLAN}&policy=edit`;
    await stashedDraft(entry);
    mount({ permissions: MANAGE, entry });
    const fresh = await policyDrawer();
    expect((within(fresh).getByLabelText(/Stale after/) as HTMLInputElement).value).toBe("30");
    expect(draftKept()).toBe(false);
  });

  it("closing the restored drawer abandons the draft", async () => {
    const entry = `${WITH_PLAN}&policy=edit`;
    await stashedDraft(entry);
    markStepUpReturn(entry);
    mount({ permissions: MANAGE, entry });
    await policyDrawer();
    fireEvent.click(screen.getByRole("button", { name: "Close edit eligibility policy" }));
    await waitFor(() => expect(policyDrawerGone()).toBe(true));
    expect(draftKept()).toBe(false);
  });

  it("Cancel abandons the draft", async () => {
    const entry = `${WITH_PLAN}&policy=edit`;
    await stashedDraft(entry);
    markStepUpReturn(entry);
    mount({ permissions: MANAGE, entry });
    const back = await policyDrawer();
    fireEvent.click(within(back).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(policyDrawerGone()).toBe(true));
    expect(draftKept()).toBe(false);
  });

  it("switching entity drops the open drawer, the patient and the plan, and abandons the draft", async () => {
    const OTHER = "88888888-8888-4888-8888-888888888889";
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
    const entry = `${WITH_PLAN}&policy=edit`;
    await stashedDraft(entry, { entities: two });
    markStepUpReturn(entry);
    mount({ permissions: MANAGE, entry, entities: two });
    await policyDrawer();
    fireEvent.change(await screen.findByLabelText("Provider entity"), { target: { value: OTHER } });
    await waitFor(() => expect(policyDrawerGone()).toBe(true));
    await screen.findByText("Choose a patient");
    expect(draftKept()).toBe(false);
  });
});
