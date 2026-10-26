// The add / edit enrollment form (M41): client checks, the Idempotency-Key contract, fixed-word server errors, and the step-up
// redirect-and-resume path (draft stashed, restored on return, never auto-submitted). Synthetic data only.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markStepUpReturn } from "../../shell/step-up-redirect";
import type { EnrollmentView } from "./commercial-model";
import {
  type Call,
  ENROLLMENT_ID,
  ENTITY_ID,
  PAYER_ID,
  enrollmentRow,
  mountScreen,
} from "./commercial-test-harness";
import type { Responder } from "./commercial-test-harness";
import { EnrollmentForm, type EnrollmentFormMode } from "./enrollment-form";

const COLLECTION = "POST /api/v1/billing/commercial/enrollments";
const ITEM = `PATCH /api/v1/billing/commercial/enrollments/${ENROLLMENT_ID}`;
const PATH = "/commercial/billing/enrollments";
const ENTRY = `${PATH}?entity=${ENTITY_ID}&enrollment=new`;
const CREATE: EnrollmentFormMode = {
  kind: "create",
  payers: [{ id: PAYER_ID, name: "Synthetic Health Plan" }],
};
const EXISTING = enrollmentRow() as unknown as EnrollmentView;

function Where(): null {
  const { pathname, search } = useLocation();
  document.body.dataset.where = pathname + search;
  return null;
}

function mount(
  responder: Responder,
  calls: Call[],
  opts: {
    mode?: EnrollmentFormMode;
    resume?: boolean;
    onSaved?: () => void;
    onClose?: () => void;
  } = {},
): ReturnType<typeof mountScreen> {
  const mode = opts.mode ?? CREATE;
  return mountScreen({
    routes: { [COLLECTION]: responder, [ITEM]: responder },
    calls,
    element: (
      <>
        <Where />
        <EnrollmentForm
          mode={mode}
          providerEntityId={ENTITY_ID}
          resume={opts.resume ?? false}
          onSaved={opts.onSaved ?? (() => undefined)}
          onClose={opts.onClose ?? (() => undefined)}
          onReload={() => undefined}
        />
      </>
    ),
    routePath: PATH,
    entry: ENTRY,
    permissions: ["commercial_billing.read", "commercial_billing.manage_enrollment"],
  });
}

function fill(over: { key?: string; from?: string; to?: string; evidence?: string } = {}): void {
  fireEvent.change(screen.getByLabelText(/Payer/), { target: { value: PAYER_ID } });
  fireEvent.change(screen.getByLabelText(/Clearinghouse key/), {
    target: { value: over.key ?? "stedi" },
  });
  fireEvent.change(screen.getByLabelText(/Effective from/), {
    target: { value: over.from ?? "2026-03-01" },
  });
  if (over.to !== undefined) {
    fireEvent.change(screen.getByLabelText(/Effective to/), { target: { value: over.to } });
  }
  if (over.evidence !== undefined) {
    fireEvent.change(screen.getByLabelText(/Evidence reference/), {
      target: { value: over.evidence },
    });
  }
}
const submitButton = (name: RegExp = /^Add enrollment/): HTMLElement =>
  screen.getByRole("button", { name });
const writes = (calls: Call[]): Call[] => calls.filter((c) => c.method !== "GET");
const created = { status: 201, body: enrollmentRow() };

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  delete document.body.dataset.where;
});

describe("EnrollmentForm (add)", () => {
  it("posts every field with a 1..128 char Idempotency-Key and reports success", async () => {
    const calls: Call[] = [];
    const onSaved = vi.fn();
    mount(() => created, calls, { onSaved });
    fill({ to: "2026-12-31", evidence: "DOC-1/a#2" });
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: "enrolled" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [post] = writes(calls);
    expect(post?.body).toEqual({
      providerEntityId: ENTITY_ID,
      payerId: PAYER_ID,
      clearinghouseKey: "stedi",
      status: "enrolled",
      effectiveFrom: "2026-03-01",
      effectiveTo: "2026-12-31",
      evidenceRef: "DOC-1/a#2",
    });
    const key = post?.headers.get("idempotency-key") ?? "";
    expect(key.length).toBeGreaterThanOrEqual(1);
    expect(key.length).toBeLessThanOrEqual(128);
  });

  it("sends nulls for a blank end date and evidence reference", async () => {
    const calls: Call[] = [];
    const onSaved = vi.fn();
    mount(() => created, calls, { onSaved });
    fill();
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = writes(calls)[0]?.body as Record<string, unknown>;
    expect(body.effectiveTo).toBeNull();
    expect(body.evidenceRef).toBeNull();
  });

  it("sends nothing and says why when the client checks fail", async () => {
    const calls: Call[] = [];
    mount(() => created, calls);
    fireEvent.click(submitButton());
    expect(await screen.findByText("Choose a payer.")).toBeTruthy();

    fill({ key: "Bad Key", to: "2026-04-01" });
    fireEvent.click(submitButton());
    expect(
      await screen.findByText(/lowercase letters, digits, hyphens or underscores/),
    ).toBeTruthy();

    fill({ key: "ok", from: "2026-03-10", to: "2026-03-01", evidence: "has space" });
    fireEvent.click(submitButton());
    expect(await screen.findByText("The end date cannot be before the start date.")).toBeTruthy();
    expect(screen.getByText(/no spaces/)).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it("uses a new Idempotency-Key for a separate submission", async () => {
    const calls: Call[] = [];
    const onSaved = vi.fn();
    mount(() => created, calls, { onSaved });
    fill();
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    fill({ key: "other" });
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    const [a, b] = writes(calls);
    expect(a?.headers.get("idempotency-key")).not.toBe(b?.headers.get("idempotency-key"));
  });

  it.each([500, 503])(
    "uses a NEW key when retried after a %i (the server caches the error)",
    async (status) => {
      const calls: Call[] = [];
      let n = 0;
      mount(() => {
        n += 1;
        return n === 1 ? { status, body: { error: { code: "INTERNAL" } } } : created;
      }, calls);
      fill();
      fireEvent.click(submitButton());
      await screen.findByText(/did not go through/i);
      fireEvent.click(submitButton());
      await waitFor(() => expect(writes(calls)).toHaveLength(2));
      const [a, b] = writes(calls);
      expect(a?.headers.get("idempotency-key")).toBeTruthy();
      expect(b?.headers.get("idempotency-key")).not.toBe(a?.headers.get("idempotency-key"));
    },
  );

  it("KEEPS the key when the fetch threw (no response arrived)", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(() => {
      n += 1;
      if (n === 1) throw new TypeError("network down");
      return created;
    }, calls);
    fill();
    fireEvent.click(submitButton());
    await screen.findByText(/did not go through/i);
    fireEvent.click(submitButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    const [a, b] = writes(calls);
    expect(a?.headers.get("idempotency-key")).toBeTruthy();
    expect(b?.headers.get("idempotency-key")).toBe(a?.headers.get("idempotency-key"));
  });

  it("drops the key when a field changes after a failure", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(() => {
      n += 1;
      return n === 1 ? { status: 500, body: {} } : created;
    }, calls);
    fill();
    fireEvent.click(submitButton());
    await screen.findByText(/did not go through/i);
    fireEvent.change(screen.getByLabelText(/Clearinghouse key/), { target: { value: "other" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    const [a, b] = writes(calls);
    expect(b?.headers.get("idempotency-key")).not.toBe(a?.headers.get("idempotency-key"));
  });

  it("drops the key after a 409 so a corrected retry is a new attempt", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(() => {
      n += 1;
      return n === 1 ? { status: 409, body: { error: { code: "CONFLICT" } } } : created;
    }, calls);
    fill();
    fireEvent.click(submitButton());
    await screen.findByText(/overlaps another enrollment/);
    fireEvent.click(submitButton()); // no field change: still a new key after a 409
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    const [a, b] = writes(calls);
    expect(b?.headers.get("idempotency-key")).not.toBe(a?.headers.get("idempotency-key"));
  });

  it("blocks a double submit while one is in flight", async () => {
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    mount(
      () =>
        new Promise((resolve) => {
          release = () => resolve(created);
        }),
      calls,
    );
    fill();
    const form = submitButton().closest("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    release?.();
  });

  it("shows 404, 409, 422 and 403 in fixed words and never echoes the server text", async () => {
    const cases: [number, RegExp][] = [
      [404, /not in your scope/],
      [409, /overlaps another enrollment.*reload the list/is],
      [422, /not accepted.*active commercial payer/is],
      [403, /not allowed to manage enrollments/],
    ];
    for (const [status, text] of cases) {
      mount(() => ({ status, body: { error: { code: "X", message: "SERVER-ECHO" } } }), []);
      fill();
      fireEvent.click(submitButton());
      const alert = await screen.findByText(text);
      expect(alert.textContent).not.toContain("SERVER-ECHO");
      cleanup();
    }
  });

  it("sends a 401 to /login", async () => {
    mount(() => ({ status: 401, body: { error: { code: "UNAUTHENTICATED" } } }), []);
    fill();
    fireEvent.click(submitButton());
    await waitFor(() => expect(document.body.dataset.where).toBe("/login"));
  });
});

describe("EnrollmentForm (edit)", () => {
  const editMode: EnrollmentFormMode = { kind: "edit", enrollment: EXISTING };

  it("patches only status, end date and evidence, with the entity in the body", async () => {
    const calls: Call[] = [];
    const onSaved = vi.fn();
    mount(() => ({ status: 200, body: enrollmentRow() }), calls, { mode: editMode, onSaved });
    expect(screen.queryByLabelText(/Clearinghouse key/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: "suspended" } });
    fireEvent.change(screen.getByLabelText(/Effective to/), { target: { value: "2026-06-30" } });
    fireEvent.change(screen.getByLabelText(/Evidence reference/), { target: { value: "" } });
    fireEvent.click(submitButton(/^Save changes/));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [patch] = writes(calls);
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({
      providerEntityId: ENTITY_ID,
      status: "suspended",
      effectiveTo: "2026-06-30",
      evidenceRef: null,
    });
    expect(patch?.headers.get("idempotency-key")).toBeTruthy();
    expect(patch?.headers.get("if-match")).toBeNull();
  });

  it("rejects an end date before the fixed start date", async () => {
    const calls: Call[] = [];
    mount(() => ({ status: 200, body: enrollmentRow() }), calls, { mode: editMode });
    fireEvent.change(screen.getByLabelText(/Effective to/), { target: { value: "2025-12-31" } });
    fireEvent.click(submitButton(/^Save changes/));
    await screen.findByText("The end date cannot be before the start date.");
    expect(writes(calls)).toHaveLength(0);
  });
});

describe("EnrollmentForm step-up", () => {
  const stepUpRefusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
  const draftKeys = (): string[] =>
    Object.keys(window.sessionStorage).filter((k) => k.startsWith("wx.step-up-draft:"));

  it("saves the draft (no key, no secret) and redirects to /step-up on a stale session", async () => {
    mount(() => stepUpRefusal, []);
    fill({ evidence: "DOC-9" });
    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(document.body.dataset.where).toBe(`/step-up?returnTo=${encodeURIComponent(ENTRY)}`),
    );
    const [key] = draftKeys();
    expect(key).toContain("commercial.enrollment.create");
    const stored = JSON.parse(window.sessionStorage.getItem(key ?? "") ?? "{}") as {
      value: Record<string, string>;
    };
    expect(stored.value).toMatchObject({ key: "stedi", evidence: "DOC-9", payerId: PAYER_ID });
    expect(JSON.stringify(stored)).not.toMatch(/idempotency|token/i);
  });

  it("restores the draft on return, does not auto-submit, and saves once on the user's submit", async () => {
    // Round trip: refusal, then back from /step-up with the one-shot marker.
    const first: Call[] = [];
    mount(() => stepUpRefusal, first);
    fill({ evidence: "DOC-9", to: "2026-12-31" });
    fireEvent.click(submitButton());
    await waitFor(() => expect(document.body.dataset.where).toMatch(/^\/step-up/));
    cleanup();
    markStepUpReturn(ENTRY);

    const calls: Call[] = [];
    const onSaved = vi.fn();
    mount(() => created, calls, { resume: true, onSaved });
    expect((screen.getByLabelText(/Clearinghouse key/) as HTMLInputElement).value).toBe("stedi");
    expect((screen.getByLabelText(/Payer/) as HTMLSelectElement).value).toBe(PAYER_ID);
    expect((screen.getByLabelText(/Effective to/) as HTMLInputElement).value).toBe("2026-12-31");
    expect((screen.getByLabelText(/Evidence reference/) as HTMLInputElement).value).toBe("DOC-9");
    await new Promise((r) => setTimeout(r, 30));
    expect(writes(calls)).toHaveLength(0); // restoring never submits

    fireEvent.click(submitButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(writes(calls)).toHaveLength(1);
    expect(draftKeys()).toHaveLength(0); // consumed on success: a later open starts empty
  });

  it("does not restore a draft when the user is not returning from step-up", () => {
    mount(() => stepUpRefusal, []);
    fill({ evidence: "DOC-9" });
    fireEvent.click(submitButton());
    cleanup();
    mount(() => created, [], { resume: false });
    expect((screen.getByLabelText(/Clearinghouse key/) as HTMLInputElement).value).toBe("");
  });

  it("clears the draft on cancel", async () => {
    const onClose = vi.fn();
    mount(() => stepUpRefusal, [], { onClose });
    fill();
    fireEvent.click(submitButton());
    await waitFor(() => expect(draftKeys()).toHaveLength(1));
    cleanup();
    mount(() => created, [], { resume: true, onClose });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(draftKeys()).toHaveLength(0);
  });

  it("a stale step-up on the retry redirects again with a fresh key, then saves once after the ceremony", async () => {
    const calls: Call[] = [];
    let n = 0;
    mount(() => {
      n += 1;
      return n <= 2 ? stepUpRefusal : created;
    }, calls);
    fill();
    fireEvent.click(submitButton());
    await waitFor(() => expect(document.body.dataset.where).toMatch(/^\/step-up/));
    cleanup();
    delete document.body.dataset.where;
    markStepUpReturn(ENTRY);
    mount(
      () => {
        n += 1;
        return n <= 2 ? stepUpRefusal : created;
      },
      calls,
      { resume: true },
    );
    fireEvent.click(submitButton()); // the session went stale again
    await waitFor(() => expect(document.body.dataset.where).toMatch(/^\/step-up/));
    expect(draftKeys()).toHaveLength(1);
    const [a, b] = writes(calls);
    expect(b?.headers.get("idempotency-key")).not.toBe(a?.headers.get("idempotency-key"));
  });

  it("restores only the editable fields of an edit", async () => {
    const editMode: EnrollmentFormMode = { kind: "edit", enrollment: EXISTING };
    mount(() => stepUpRefusal, [], { mode: editMode });
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: "suspended" } });
    fireEvent.click(submitButton(/^Save changes/));
    await waitFor(() => expect(draftKeys()).toHaveLength(1));
    expect(draftKeys()[0]).toContain(`commercial.enrollment.update|${ENROLLMENT_ID}`);
    cleanup();
    mount(() => created, [], { mode: editMode, resume: true });
    expect((screen.getByLabelText(/Status/) as HTMLSelectElement).value).toBe("suspended");
  });
});
