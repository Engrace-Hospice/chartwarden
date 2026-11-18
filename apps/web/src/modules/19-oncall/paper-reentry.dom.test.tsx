// @vitest-environment jsdom
// Re-entering a paper call is a multi-field form on a worklist screen, so it opens as a drawer in the detail rail beside
// the worklist (the redesign's pattern), not as a dialog over it. Cancel closes it and files nothing; File the call stays
// disabled until the form is complete. Every window starts from a blank form: a draft typed for one outage window never
// carries into another's filing (the back-dated call is the one write that can hide a coverage gap). A refused or lost
// write is announced in the drawer and never leaves it stuck; while it is in flight the worklist beside it is inert.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider, isoToLocalInput } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_ANSWER_MESSAGE } from "./drawer-write";
import type { PaperReentryWorklistView } from "./oncall-api";
import { PaperReentryWorklistScreen } from "./paper-reentry";

afterEach(cleanup);

const PATIENT = "55555555-aaaa-4aaa-8aaa-555555555555";
const ADMISSION = "66666666-bbbb-4bbb-8bbb-666666666666";
const REFUSAL = "That time falls outside the outage window.";

const rowA: PaperReentryWorklistView = {
  id: "w1",
  providerEntityId: "pe-1",
  outageWindowId: "ow-1",
  shiftId: "shift-1",
  shiftStartsAt: "2026-11-17T20:00:00.000Z",
  shiftEndsAt: "2026-11-18T08:00:00.000Z",
  assignedToMembershipId: "m-lopez",
  reenteredAt: null,
  linkedTriageCallId: null,
  expiresAt: new Date(Date.now() + 36 * 3600_000).toISOString(),
};
const rowB: PaperReentryWorklistView = {
  ...rowA,
  id: "w2",
  outageWindowId: "ow-2",
  shiftId: "shift-2",
  shiftStartsAt: "2026-11-16T20:00:00.000Z",
  shiftEndsAt: "2026-11-17T08:00:00.000Z",
  expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const refused = {
  data: undefined,
  error: { error: { code: "OUTSIDE_WINDOW", message: REFUSAL, correlationId: "c" } },
  response: new Response(null, { status: 422 }),
};

type Post = ReturnType<typeof vi.fn>;

function mount(post: Post = vi.fn(async () => ok({}))): { post: Post } {
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/patients") {
        return ok({
          items: [
            {
              id: PATIENT,
              lastName: "Testpatient",
              firstName: "Ada",
              mrn: "MRN-TEST-1",
              status: "active",
              dob: "1950-01-01",
            },
          ],
          nextCursor: null,
        });
      }
      if (path === "/api/v1/patients/{patientId}/admissions") {
        return ok({
          items: [
            {
              id: ADMISSION,
              state: "active",
              admissionAt: "2026-01-02T00:00:00.000Z",
              dischargedAt: null,
            },
          ],
        });
      }
      return ok([rowA, rowB]);
    }),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <PaperReentryWorklistScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const DRAWER = "Re-enter a call taken on paper";

/** The worklist's row buttons, soonest-expiring first (window A, then window B). */
const rowButtons = async () => screen.findAllByRole("button", { name: "Re-enter a call" });

async function openRow(index: number): Promise<HTMLElement> {
  fireEvent.click((await rowButtons())[index] as HTMLElement);
  return screen.findByRole("complementary", { name: DRAWER });
}

const fileButton = (drawer: HTMLElement) =>
  within(drawer).getByRole("button", { name: "File the call" }) as HTMLButtonElement;

async function pickOption(drawer: HTMLElement, field: RegExp, option: RegExp): Promise<void> {
  fireEvent.focus(within(drawer).getByRole("combobox", { name: field }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function draftAnAnchoredCall(drawer: HTMLElement): Promise<void> {
  fireEvent.change(within(drawer).getByLabelText("Caller name"), {
    target: { value: "Jordan Testcaller" },
  });
  fireEvent.change(within(drawer).getByLabelText("Caller kind"), { target: { value: "patient" } });
  fireEvent.change(within(drawer).getByLabelText("Chief complaint as recorded on paper"), {
    target: { value: "Pain overnight" },
  });
  await pickOption(drawer, /Patient \(optional\)/, /Testpatient/);
  await pickOption(drawer, /Admission \(optional\)/, /Admitted/);
}

function expectBlankForm(drawer: HTMLElement, outage: PaperReentryWorklistView): void {
  expect((within(drawer).getByLabelText("Caller name") as HTMLInputElement).value).toBe("");
  expect((within(drawer).getByLabelText("Caller kind") as HTMLSelectElement).value).toBe(
    "caregiver",
  );
  expect((within(drawer).getByLabelText("Inbound channel") as HTMLSelectElement).value).toBe(
    "phone",
  );
  expect(
    (within(drawer).getByLabelText("Chief complaint as recorded on paper") as HTMLTextAreaElement)
      .value,
  ).toBe("");
  expect(
    (within(drawer).getByRole("combobox", { name: /Patient \(optional\)/ }) as HTMLInputElement)
      .value,
  ).toBe("");
  expect(
    (within(drawer).getByRole("combobox", { name: /Admission \(optional\)/ }) as HTMLInputElement)
      .value,
  ).toBe("");
  expect(
    (within(drawer).getByLabelText("When the call actually came in") as HTMLInputElement).value,
  ).toBe(isoToLocalInput(outage.shiftStartsAt));
}

describe("paper re-entry worklist — re-enter a call", () => {
  it("opens the form as a drawer beside the worklist, not a dialog over it", async () => {
    mount();
    const drawer = await openRow(0);
    expect(within(drawer).getByLabelText("When the call actually came in")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The worklist stays on the page while the form is open.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("closes from Cancel without filing anything", async () => {
    const { post } = mount();
    const drawer = await openRow(0);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });

  it("pre-fills the call time, and keeps File the call disabled while that time is empty", async () => {
    mount();
    const drawer = await openRow(0);
    const when = within(drawer).getByLabelText(
      "When the call actually came in",
    ) as HTMLInputElement;
    expect(when.value).not.toBe("");
    expect(fileButton(drawer).disabled).toBe(false);
    fireEvent.change(when, { target: { value: "" } });
    expect(fileButton(drawer).disabled).toBe(true);
  });

  it("keeps File the call disabled until the patient and admission are chosen together or not at all", async () => {
    mount();
    const drawer = await openRow(0);
    await pickOption(drawer, /Patient \(optional\)/, /Testpatient/);
    expect(screen.getByText("Patient and admission travel together or not at all.")).toBeTruthy();
    expect(fileButton(drawer).disabled).toBe(true);
    await pickOption(drawer, /Admission \(optional\)/, /Admitted/);
    expect(fileButton(drawer).disabled).toBe(false);
  });

  it("files the call against its window with the entered anchor and closes the drawer", async () => {
    const { post } = mount();
    const drawer = await openRow(0);
    await draftAnAnchoredCall(drawer);
    fireEvent.click(fileButton(drawer));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]?.[0]).toBe("/api/v1/triage-calls/paper-reentry");
    expect(post.mock.calls[0]?.[1]).toMatchObject({
      body: {
        worklistId: "w1",
        providerEntityId: "pe-1",
        inboundChannel: "phone",
        callerKind: "patient",
        callerDisplayName: "Jordan Testcaller",
        patientId: PATIENT,
        admissionId: ADMISSION,
        chiefComplaintText: "Pain overnight",
      },
    });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
  });

  it("starts window B from a blank form after window A was drafted (no stale caller or patient anchor)", async () => {
    const { post } = mount();
    const drawerA = await openRow(0);
    await draftAnAnchoredCall(drawerA);
    expect((within(drawerA).getByLabelText("Caller name") as HTMLInputElement).value).toBe(
      "Jordan Testcaller",
    );

    const drawerB = await openRow(1);
    expectBlankForm(drawerB, rowB);
    // The anchor is gone, so the blank form is fileable and files nothing from window A's draft.
    fireEvent.click(fileButton(drawerB));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = (post.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body;
    expect(body).toMatchObject({ worklistId: "w2", callerKind: "caregiver" });
    expect(body).not.toHaveProperty("patientId");
    expect(body).not.toHaveProperty("admissionId");
    expect(body).not.toHaveProperty("callerDisplayName");
    expect(body).not.toHaveProperty("chiefComplaintText");
  });

  it("reopens blank after Cancel", async () => {
    mount();
    const drawer = await openRow(0);
    await draftAnAnchoredCall(drawer);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
    expectBlankForm(await openRow(0), rowA);
  });

  it("shows a refused write in the drawer beside Save, and drops it on Cancel and reopen", async () => {
    mount(vi.fn(async () => refused));
    const drawer = await openRow(0);
    fireEvent.click(fileButton(drawer));
    expect((await within(drawer).findByRole("alert")).textContent).toContain(REFUSAL);
    // Only in the drawer: not also a page banner above the worklist.
    expect(screen.getAllByText(REFUSAL)).toHaveLength(1);
    expect(fileButton(drawer).disabled).toBe(false);

    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
    await openRow(0);
    expect(screen.queryByText(REFUSAL)).toBeNull();
  });

  it("frees the drawer and says so when the request is lost (the client rejects)", async () => {
    mount(
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const drawer = await openRow(0);
    fireEvent.click(fileButton(drawer));
    expect((await within(drawer).findByRole("alert")).textContent).toContain(NO_ANSWER_MESSAGE);
    expect(fileButton(drawer).disabled).toBe(false);
    const cancel = within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
  });

  it("makes the worklist inert while the write is in flight, so no row can swap the form", async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    const pending = new Promise<ReturnType<typeof ok>>((resolve) => {
      finish = resolve;
    });
    mount(vi.fn(async () => pending));
    const drawer = await openRow(0);
    fireEvent.click(fileButton(drawer));

    await waitFor(() => expect(fileButton(drawer).disabled).toBe(true));
    const rows = await screen.findAllByRole("button", { name: "Re-enter a call", hidden: true });
    for (const button of rows) expect(button.closest("[inert]")).not.toBeNull();
    expect(drawer.closest("[inert]")).toBeNull();
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    finish(ok({}));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: DRAWER })).toBeNull());
    await waitFor(() => expect(document.querySelector("[inert]")).toBeNull());
  });
});
