// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HopeActionModal } from "../hope-action-modal";
import { SPEC_NOT_IN_FORCE_MESSAGE } from "../hope-api";
import {
  SESSION,
  assessment,
  clientFor,
  item,
  ok,
  renderWorkspace,
  review,
  useStubbedLocalStorage,
  workspace,
} from "./workspace-test-kit";

// Group g2: what the assessment screen and the skip dialog say when a write does not land. A skip is terminal, so its reason is the
// clinician's own choice; a stale page is recognised by the contract (status and code), not by the server's wording; the
// real M10_SPEC_NOT_IN_FORCE text is replaced by words a clinician can act on; and the save header says "not confirmed" exactly
// when the field and the alert say it could not be confirmed.

/** The real 422 text of M10_SPEC_NOT_IN_FORCE (hope-spec-registry.ts): it contains "version" and an Idempotency-Key instruction. */
const REAL_SPEC_NOT_IN_FORCE_TEXT =
  "No HOPE spec version is in force for this record's target date. An administrator needs to load the spec version that covers it. The idempotency layer replays this 422 for 24 h on the same Idempotency-Key, so after the spec is loaded use a NEW Idempotency-Key.";

type Mock = ReturnType<typeof vi.fn>;
const refusal = (status: number, code: string, message: string) => ({
  data: undefined,
  error: { error: { code, message } },
  response: new Response(null, { status }),
});
const emptyReply = (status: number) => ({
  data: undefined,
  error: undefined,
  response: new Response(null, { status }),
});

describe("the skip dialog", () => {
  const SKIP = "Skip window";
  function renderSkip(post: Mock, open = true) {
    const client = { GET: vi.fn(async () => ok({})), POST: post } as unknown as ApiClient;
    const view = (isOpen: boolean) => (
      <ApiClientProvider client={client}>
        <HopeActionModal
          open={isOpen}
          action="skip"
          targetId="schedule-1"
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </ApiClientProvider>
    );
    const rendered = render(view(open));
    return { rendered, view };
  }
  const skipButton = () => screen.getByRole("button", { name: SKIP }) as HTMLButtonElement;
  const reason = () => screen.getByLabelText(/Reason/) as HTMLSelectElement;

  it("starts without a reason and cannot skip until the clinician picks one", () => {
    const post = vi.fn(async () => ok({ id: "schedule-1" }));
    renderSkip(post);

    expect(reason().value).toBe("");
    expect(within(reason()).getByRole("option", { name: "Select a reason" })).toBeTruthy();
    expect(skipButton().disabled).toBe(true);
    fireEvent.click(skipButton());
    expect(post).not.toHaveBeenCalled();
  });

  it("sends exactly the reason that was chosen", async () => {
    const post = vi.fn(async () => ok({ id: "schedule-1" }));
    renderSkip(post);

    fireEvent.change(reason(), { target: { value: "transferred_out" } });
    expect(skipButton().disabled).toBe(false);
    fireEvent.click(skipButton());

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(init.body).toEqual({ reasonCode: "transferred_out" });
  });

  it("does not carry a reason over to the next time it opens", () => {
    const post = vi.fn(async () => ok({ id: "schedule-1" }));
    const { rendered, view } = renderSkip(post);
    fireEvent.change(reason(), { target: { value: "patient_revoked" } });

    rendered.rerender(view(false));
    rendered.rerender(view(true));

    expect(reason().value).toBe("");
    expect(skipButton().disabled).toBe(true);
  });
});

describe("an answer refused by the server", () => {
  useStubbedLocalStorage();

  async function answerCpr(client: ApiClient) {
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));
  }
  const patchOf = (client: ApiClient) => client.PATCH as unknown as Mock;
  const noConflictBanner = () => {
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Reload/ })).toBeNull();
  };

  it("is a refusal, not a stale page, when the real M10_SPEC_NOT_IN_FORCE text happens to say 'version'", async () => {
    const client = clientFor();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(422, "M10_SPEC_NOT_IN_FORCE", REAL_SPEC_NOT_IN_FORCE_TEXT),
    );
    await answerCpr(client);

    expect(await screen.findByText(SPEC_NOT_IN_FORCE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(/Idempotency-Key/i)).toBeNull();
    expect(screen.getByText("Save failed")).toBeTruthy();
    noConflictBanner();
  });

  it("is not a stale page for a non-409 refusal that mentions a conflict in its words", async () => {
    const client = clientFor();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(400, "M10_BAD_REQUEST", "That value conflicts with the stale version of the form."),
    );
    await answerCpr(client);

    expect(await screen.findByText(/conflicts with the stale version/)).toBeTruthy();
    noConflictBanner();
  });

  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("offline"))],
    ["a non-OK reply with no body", async () => emptyReply(502)],
    ["a server fault", async () => refusal(500, "INTERNAL", "stack trace here")],
  ])("says the save is not confirmed, in the header too, for %s", async (_name, answer) => {
    const client = clientFor();
    patchOf(client).mockImplementationOnce(answer);
    await answerCpr(client);

    expect(await screen.findByText("Save not confirmed")).toBeTruthy();
    expect(screen.queryByText("Save failed")).toBeNull();
    expect(
      screen.getByText(/Could not confirm that this answer was saved|could not be confirmed/),
    ).toBeTruthy();
  });

  it("still says Save failed for a refusal the server explained", async () => {
    const client = clientFor();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(422, "M10_BAD_VALUE", "That value is not allowed here."),
    );
    await answerCpr(client);

    expect(await screen.findByText("That value is not allowed here.")).toBeTruthy();
    expect(screen.getByText("Save failed")).toBeTruthy();
    expect(screen.queryByText("Save not confirmed")).toBeNull();
  });
});

describe("confirming the HUV completion date", () => {
  useStubbedLocalStorage();
  const HUV = { ...assessment, rfaKind: "02_huv1" };
  const huvWorkspace = () => {
    const base = workspace();
    return { ...base, assessment: { ...base.assessment, isc: "HUV", rfaKind: "02_huv1" } };
  };
  const patchOf = (client: ApiClient) => client.PATCH as unknown as Mock;
  async function openReview(client: ApiClient) {
    renderWorkspace(client, SESSION);
    fireEvent.click(await screen.findByRole("button", { name: /Review/ }));
    return (await screen.findByLabelText("Assessment completed on")) as HTMLInputElement;
  }
  const confirm = () => screen.getByRole("button", { name: "Confirm date" }) as HTMLButtonElement;
  function confirmDate(input: HTMLInputElement, value = "2026-09-10") {
    fireEvent.change(input, { target: { value } });
    fireEvent.click(confirm());
  }
  const huvClient = () => clientFor({ assessment: HUV, workspace: huvWorkspace() });

  it.each([
    ["a rejected request", () => Promise.reject(new TypeError("offline"))],
    ["a non-OK reply with no body", async () => emptyReply(502)],
  ])(
    "says in the header and next to the control that the save is not confirmed, for %s",
    async (_name, answer) => {
      const client = huvClient();
      patchOf(client).mockImplementationOnce(answer);
      confirmDate(await openReview(client));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(
        "Could not confirm that the completion date was saved. Check the assessment before trying again.",
      );
      expect(screen.getByText("Save not confirmed")).toBeTruthy();
      expect(screen.queryByText("Save failed")).toBeNull();
      // The pressed button was disabled while the request was out: the failure takes focus back, and Confirm is usable again.
      await waitFor(() => expect(document.activeElement).toBe(alert));
      expect(confirm().disabled).toBe(false);
    },
  );

  it("shows the server's reason for a refusal, with Save failed in the header", async () => {
    const client = huvClient();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(422, "M10_BAD_DATE", "The completion date cannot be before the admission date."),
    );
    confirmDate(await openReview(client));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "The completion date cannot be before the admission date.",
    );
    expect(screen.getByText("Save failed")).toBeTruthy();
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
  });

  it("words M10_SPEC_NOT_IN_FORCE for a clinician, not as a stale page", async () => {
    const client = huvClient();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(422, "M10_SPEC_NOT_IN_FORCE", REAL_SPEC_NOT_IN_FORCE_TEXT),
    );
    confirmDate(await openReview(client));

    expect((await screen.findByRole("alert")).textContent).toBe(SPEC_NOT_IN_FORCE_MESSAGE);
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
  });

  it("leaves a stale version to the conflict banner, with no second alert beside the control", async () => {
    const client = huvClient();
    patchOf(client).mockImplementationOnce(async () =>
      refusal(409, "M10_VERSION_CONFLICT", "Changed."),
    );
    confirmDate(await openReview(client));

    expect((await screen.findAllByText(/changed elsewhere/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Changed.")).toBeNull();
    expect(screen.queryByText(/Could not confirm that the completion date/)).toBeNull();
  });

  it("clears the failure once a later attempt lands", async () => {
    const client = huvClient();
    patchOf(client).mockImplementationOnce(async () => emptyReply(502));
    const input = await openReview(client);
    confirmDate(input);
    await screen.findByText(/Could not confirm that the completion date/);

    fireEvent.change(input, { target: { value: "2026-09-11" } });
    fireEvent.click(confirm());

    await waitFor(() =>
      expect(screen.queryByText(/Could not confirm that the completion date/)).toBeNull(),
    );
    expect(await screen.findByText(/Auto-saved/)).toBeTruthy();
  });
});

describe("a Sign that the server refuses with M10_SPEC_NOT_IN_FORCE", () => {
  useStubbedLocalStorage();

  it("tells the signer what to do, without the integrator's Idempotency-Key advice", async () => {
    const client = clientFor({
      review: review({
        validation: { errorCount: 0, warningCount: 0, hasBlockingErrors: false, findings: [] },
        readiness: { readyToSign: true, blockers: [] },
      }),
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [item({ itemCode: "A0220", label: "Admission date", value: "2026-09-08" })],
          },
        ],
      }),
    });
    (client.POST as unknown as Mock).mockImplementationOnce(async () =>
      refusal(422, "M10_SPEC_NOT_IN_FORCE", REAL_SPEC_NOT_IN_FORCE_TEXT),
    );
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Sign & complete" })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "Complete Admission" });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(SPEC_NOT_IN_FORCE_MESSAGE);
  });
});
