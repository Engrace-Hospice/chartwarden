// @vitest-environment jsdom
import { HOPE_ATTESTATION_VERSION } from "@chartwarden/types";
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import {
  clearAllStepUpDrafts,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../../shell/step-up-redirect";
import { ADMISSION_PROJECTION_GAP_MESSAGE, REQUEST_TIMEOUT_MS } from "../hope-api";
import { CompleteSfvDialog, type SfvDialogApi } from "../hope-sfv-complete-dialog";
import { sessionWith, useStubbedLocalStorage } from "./workspace-test-kit";

// Completing a Symptom Follow-Up Visit is a signed-record action. The server binds the author to the CALLER'S OWN
// role keys (`assertAuthorBoundToActor`), so this dialog offers exactly the disciplines the session holds and never
// a default the server would refuse.

const ASSESSMENT = { id: "hope-1", admissionId: "adm-1" } as const;
const ITEMS = [
  { itemCode: "J2053A", label: "Impact of pain" },
  { itemCode: "J2053B", label: "Impact of shortness of breath" },
] as const;

const STALE_MESSAGE = "The attestation wording has changed. Reload the page and review it again.";

const DRAFT_KEY = stepUpDraftKey(sessionWith([]), "hope.sfv.record", ASSESSMENT.id) as string;

type Reply = { data?: unknown; error?: unknown };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface DialogOptions {
  /** The page already knows the attestation wording it shows is out of date. */
  readonly wordingChanged?: boolean;
}

/** Where a navigation landed, for a dialog that can send the signer to /step-up. */
function LocationProbe(): JSX.Element {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}

function renderDialog(
  roles: string[],
  post: SfvDialogApi["POST"] = vi.fn(async (): Promise<Reply> => ({ data: { id: "sfv-1" } })),
  items: readonly { itemCode: string; label: string }[] = ITEMS,
  options: DialogOptions = {},
) {
  const onCancel = vi.fn();
  const onCompleted = vi.fn(async () => undefined);
  const onWordingChanged = vi.fn();
  // The page owns the wording flag (the Sign dialog shares it), so the test page holds it too.
  let setShown: (show: boolean) => void = () => undefined;
  function Page(): JSX.Element {
    const [wordingChanged, setWordingChanged] = useState(options.wordingChanged ?? false);
    const [shown, setShownState] = useState(true);
    setShown = setShownState;
    return shown ? (
      <CompleteSfvDialog
        assessment={ASSESSMENT}
        api={{ POST: post }}
        items={items}
        wordingChanged={wordingChanged}
        onWordingChanged={() => {
          onWordingChanged();
          setWordingChanged(true);
        }}
        onCancel={onCancel}
        onCompleted={onCompleted}
      />
    ) : (
      <span>dialog gone</span>
    );
  }
  render(
    <SessionProvider session={sessionWith(roles)}>
      <MemoryRouter initialEntries={["/hope/assessments/hope-1"]}>
        <LocationProbe />
        <Routes>
          <Route path="/hope/assessments/:id" element={<Page />} />
          <Route path="/step-up" element={<span>step-up page</span>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>,
  );
  return {
    post,
    onCancel,
    onCompleted,
    onWordingChanged,
    hide: () => act(() => setShown(false)),
    dialog: screen.getByRole("dialog", { name: "Complete SFV" }),
  };
}

const disciplineSelect = (dialog: HTMLElement) =>
  within(dialog).queryByLabelText("Author discipline") as HTMLSelectElement | null;
const submitButton = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: "Complete SFV" }) as HTMLButtonElement;

/** A click on the dimmed area around the dialog, however the dialog's surround is built. */
function pressBackdrop(dialog: HTMLElement): void {
  fireEvent.mouseDown(dialog.parentElement as HTMLElement);
  for (const scrim of screen.getAllByRole("button", { name: "Close" })) {
    if (!dialog.contains(scrim)) fireEvent.click(scrim);
  }
}

/** Answer every question ("Show all" so each is on screen) and tick the attestation. */
function answerAndAttest(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
  for (const none of within(dialog).getAllByRole("radio", { name: "Not at all" }))
    fireEvent.click(none);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
}

describe("CompleteSfvDialog", () => {
  useStubbedLocalStorage();
  afterEach(() => {
    clearAllStepUpDrafts();
  });

  describe("author discipline is bound to the caller's own roles", () => {
    it("offers an LPN only LPN, preselected, and sends it", async () => {
      const { dialog, post } = renderDialog(["lpn"]);
      const select = disciplineSelect(dialog) as HTMLSelectElement;
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["LPN — Licensed practical nurse"]);
      expect(select.value).toBe("LPN");

      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(post).toHaveBeenCalledWith(
        "/api/v1/admissions/{admissionId}/hope/sfv",
        expect.objectContaining({
          body: expect.objectContaining({ authorDiscipline: "LPN", attestationConfirmed: true }),
        }),
      );
    });

    it("offers an NP-only caller NP, not a default RN the server would refuse", async () => {
      const { dialog, post } = renderDialog(["np"]);
      const select = disciplineSelect(dialog) as HTMLSelectElement;
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["NP — Nurse practitioner"]);
      expect(select.value).toBe("NP");

      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const [, init] = (post as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { body: unknown },
      ];
      expect(init.body).toMatchObject({ authorDiscipline: "NP" });
    });

    it("makes a caller who holds RN and NP choose: both are offered, neither is preselected", async () => {
      const { dialog, post } = renderDialog(["rn", "np"]);
      const select = disciplineSelect(dialog) as HTMLSelectElement;
      expect(select.value).toBe("");
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(["Choose a discipline", "RN — Registered nurse", "NP — Nurse practitioner"]);

      answerAndAttest(dialog);
      expect(submitButton(dialog).disabled).toBe(true);
      fireEvent.change(select, { target: { value: "NP" } });
      expect(submitButton(dialog).disabled).toBe(false);
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const [, init] = (post as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { body: unknown },
      ];
      expect(init.body).toMatchObject({ authorDiscipline: "NP" });
    });

    it("says so, and cannot submit, when the caller holds no role that may author an SFV", () => {
      const { dialog, post } = renderDialog(["md", "social_worker"]);
      expect(disciplineSelect(dialog)).toBeNull();
      expect(
        within(dialog).getByText(/your role cannot author a symptom follow-up visit/i),
      ).toBeTruthy();

      answerAndAttest(dialog);
      expect(submitButton(dialog).disabled).toBe(true);
      fireEvent.click(submitButton(dialog));
      expect(post).not.toHaveBeenCalled();
    });

    it("ignores a restored discipline the caller no longer holds", () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "NP",
        answers: { J2053A: "1" },
      });
      const { dialog } = renderDialog(["rn"]);
      expect(disciplineSelect(dialog)?.value).toBe("RN");
      expect((within(dialog).getByLabelText("SFV date") as HTMLInputElement).value).toBe(
        "2026-09-01",
      );
    });
  });

  describe("a request that never gets an answer", () => {
    it("says the write may have gone through, frees the dialog, and a retry completes it", async () => {
      const post = vi
        .fn<SfvDialogApi["POST"]>()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockResolvedValueOnce({ data: { id: "sfv-1" } });
      const { dialog, onCompleted } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));

      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(
        "Could not confirm that the follow-up visit was recorded. Check the worklist before trying again.",
      );
      // Not stuck on "Completing...": the clinician can close it or try again.
      expect(submitButton(dialog).disabled).toBe(false);
      expect(
        (within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
      ).toBe(false);

      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
      expect(post).toHaveBeenCalledTimes(2);
    });
  });

  describe("the attestation wording the signer was shown", () => {
    const refuse = (code: string, message: string) => ({ error: { error: { code, message } } });
    const STALE_MESSAGE =
      "The attestation wording has changed. Reload the page and review it again.";

    it("sends the version of the wording with the completion", async () => {
      const { dialog, post } = renderDialog(["rn"]);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      const [, init] = (post as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        { body: unknown },
      ];
      expect(init.body).toMatchObject({
        attestationConfirmed: true,
        attestationVersion: HOPE_ATTESTATION_VERSION,
      });
    });

    it("refuses a changed wording outright: says so, claims nothing was recorded, offers no retry", async () => {
      const post = vi.fn<SfvDialogApi["POST"]>(async () =>
        refuse("M10_ATTESTATION_STALE", "Attestation version 2026-01-01.1 is not current."),
      );
      const { dialog, onCompleted } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));

      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(STALE_MESSAGE);
      expect(alert.textContent).not.toMatch(/recorded|saved|completed|signed/i);
      expect(within(dialog).queryByRole("button", { name: /retry|try again/i })).toBeNull();
      // The loaded wording is out of date until the page is reloaded, so another attempt would only be refused again.
      expect(submitButton(dialog).disabled).toBe(true);
      fireEvent.click(submitButton(dialog));
      expect(post).toHaveBeenCalledTimes(1);
      expect(onCompleted).not.toHaveBeenCalled();
    });

    it("tells the page, which holds the flag, so the Sign dialog shares it", async () => {
      const post = vi.fn<SfvDialogApi["POST"]>(async () =>
        refuse("M10_ATTESTATION_STALE", "stale"),
      );
      const { dialog, onWordingChanged } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await within(dialog).findByRole("alert");
      expect(onWordingChanged).toHaveBeenCalledTimes(1);
    });

    it("still shows the refusal, with Complete SFV disabled, when the page already knows the wording changed", () => {
      const { dialog, post } = renderDialog(["rn"], undefined, ITEMS, { wordingChanged: true });
      expect(within(dialog).getByRole("alert").textContent).toContain(STALE_MESSAGE);
      answerAndAttest(dialog);
      expect(submitButton(dialog).disabled).toBe(true);
      fireEvent.click(submitButton(dialog));
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("an error that is already known when the dialog opens", () => {
    it("is announced as an alert, but does not take focus from the dialog's first field (the kit places that)", () => {
      const { dialog } = renderDialog(["rn"], undefined, ITEMS, { wordingChanged: true });
      expect(within(dialog).getByRole("alert").textContent).toContain(STALE_MESSAGE);
      expect(document.activeElement).toBe(within(dialog).getByLabelText("SFV date"));
    });
  });

  describe("what is still missing", () => {
    const hint = (dialog: HTMLElement) => {
      const id = submitButton(dialog).getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      return document.getElementById(id as string) as HTMLElement;
    };

    it("lists it beside the disabled button, which points at the list", () => {
      const { dialog } = renderDialog(["rn", "np"]);
      expect(hint(dialog).textContent).toBe(
        "To complete: choose the author discipline, answer 2 more items, tick the attestation.",
      );
    });

    it("says what is left as the form fills in, and only says ready when Complete SFV is enabled", () => {
      const { dialog } = renderDialog(["rn"]);
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /Show all/ }));
      for (const none of within(dialog).getAllByRole("radio", { name: "Not at all" }))
        fireEvent.click(none);
      // Every question answered is not "complete" while the attestation is outstanding.
      expect(hint(dialog).textContent).toBe("To complete: tick the attestation.");
      expect(within(dialog).queryByText(/Reassessment complete|Ready to complete/)).toBeNull();
      expect(submitButton(dialog).disabled).toBe(true);

      fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
      expect(hint(dialog).textContent).toBe("Ready to complete.");
      expect(submitButton(dialog).disabled).toBe(false);
    });

    it("names the missing role when the caller holds none that may author an SFV", () => {
      const { dialog } = renderDialog(["md"]);
      expect(hint(dialog).textContent).toContain("a role that may author an SFV");
    });

    it("says to reload when the attestation wording changed", () => {
      const { dialog } = renderDialog(["rn"], undefined, ITEMS, { wordingChanged: true });
      expect(hint(dialog).textContent).toContain(
        "reload the page to review the new attestation wording",
      );
    });
  });

  describe("a reply that is not a success", () => {
    const unconfirmed =
      "Could not confirm that the follow-up visit was recorded. Check the worklist before trying again.";

    it.each([
      [
        "a non-OK status with an empty body (no error, no data)",
        { response: { ok: false, status: 502 } },
      ],
      [
        "an empty error body on a gateway error",
        { error: "", response: { ok: false, status: 502 } },
      ],
      ["no data at all", {}],
    ])("treats %s as unconfirmed: nothing closes and the draft is kept", async (_name, reply) => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1", J2053B: "0" },
      });
      const post = vi.fn<SfvDialogApi["POST"]>(async () => reply as Reply);
      const { dialog, onCompleted } = renderDialog(["rn"], post);
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
      fireEvent.click(submitButton(dialog));

      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(unconfirmed);
      expect(onCompleted).not.toHaveBeenCalled();
      expect(peekStepUpDraft(DRAFT_KEY)).not.toBeNull();
    });
  });

  describe("a request nobody answers", () => {
    it("ends as unconfirmed after the wait, frees the dialog, and keeps the answers", async () => {
      const post = vi.fn<SfvDialogApi["POST"]>(() => new Promise<Reply>(() => undefined));
      const { dialog, onCompleted } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      vi.useFakeTimers();
      try {
        fireEvent.click(submitButton(dialog));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        });
      } finally {
        vi.useRealTimers();
      }
      expect(within(dialog).getByRole("alert").textContent).toContain(
        "Could not confirm that the follow-up visit was recorded.",
      );
      expect(onCompleted).not.toHaveBeenCalled();
      expect(submitButton(dialog).disabled).toBe(false);
      expect(
        (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
  });

  describe("a validation refusal", () => {
    it("shows the first detail's message, and cannot crash on a detail that is not text", async () => {
      const post = vi
        .fn<SfvDialogApi["POST"]>()
        .mockResolvedValueOnce({
          error: {
            error: {
              code: "VALIDATION_FAILED",
              message: "Review the follow-up.",
              details: [{ message: { not: "text" } }],
            },
          },
        })
        .mockResolvedValueOnce({
          error: {
            error: {
              code: "VALIDATION_FAILED",
              message: "Review the follow-up.",
              details: [{ message: "J2053C needs an answer." }],
            },
          },
        });
      const { dialog } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      expect((await within(dialog).findByRole("alert")).textContent).toContain(
        "Review the follow-up.",
      );

      fireEvent.click(submitButton(dialog));
      await waitFor(() =>
        expect(within(dialog).getByRole("alert").textContent).toContain("J2053C needs an answer."),
      );
    });
  });

  describe("a refusal with no reason given", () => {
    it.each([
      ["no error at all", { response: { ok: false, status: 400 } }],
      ["an empty error body", { error: "", response: { ok: false, status: 422 } }],
    ])(
      "is called a refusal, not an unconfirmed result, for a 4xx with %s",
      async (_name, reply) => {
        const post = vi.fn<SfvDialogApi["POST"]>(async () => reply as Reply);
        const { dialog, onCompleted } = renderDialog(["rn"], post);
        answerAndAttest(dialog);
        fireEvent.click(submitButton(dialog));

        const alert = await within(dialog).findByRole("alert");
        expect(alert.textContent).toContain("The server refused the request without saying why.");
        expect(alert.textContent).not.toMatch(/could not confirm/i);
        expect(onCompleted).not.toHaveBeenCalled();
        expect(submitButton(dialog).disabled).toBe(false);
      },
    );
  });

  describe("a server fault", () => {
    it.each([
      ["500", 500, { error: { code: "INTERNAL", message: "ECONNREFUSED 10.0.0.5:5432 pg_pool" } }],
      [
        "503 with another code",
        503,
        { error: { code: "UNAVAILABLE", message: "upstream m6 timed out at 10.0.0.9" } },
      ],
    ])(
      "shows a generic sentence, not the server's raw text, for a %s",
      async (_name, status, body) => {
        const post = vi.fn<SfvDialogApi["POST"]>(async () => ({
          error: body,
          response: { ok: false, status },
        }));
        const { dialog } = renderDialog(["rn"], post);
        answerAndAttest(dialog);
        fireEvent.click(submitButton(dialog));
        const alert = await within(dialog).findByRole("alert");
        // The write may have committed before the server failed, so it does not say "try again" as if it had not.
        expect(alert.textContent).toContain(
          "The server could not complete the request, so the result could not be confirmed. Check the record before repeating the action.",
        );
        expect(alert.textContent).not.toMatch(/try again in a moment/i);
        expect(alert.textContent).not.toMatch(/ECONNREFUSED|10\.0\.|upstream/);
        expect(submitButton(dialog).disabled).toBe(false);
      },
    );
  });

  describe("when the page goes away mid-request", () => {
    it("does not send the signer to /step-up from a dialog that is no longer there", async () => {
      const reply = deferred<Reply>();
      const post = vi.fn<SfvDialogApi["POST"]>(() => reply.promise);
      const { dialog, hide } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

      hide();
      expect(screen.getByText("dialog gone")).toBeTruthy();
      await act(async () => {
        reply.resolve({
          error: { error: { code: "STEP_UP_REQUIRED", message: "re-authenticate" } },
        });
      });
      expect(screen.getByTestId("location").textContent).toBe("/hope/assessments/hope-1");
    });
  });

  describe("with the real API client", () => {
    /** One fetch per call, recording the Idempotency-Key it carried. */
    function realClient(replies: Array<() => Response | Promise<Response>>) {
      const keys: Array<string | null> = [];
      const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
        const reply = replies.shift() as () => Response | Promise<Response>;
        keys.push(input instanceof Request ? input.headers.get("Idempotency-Key") : null);
        return reply();
      });
      return { keys, client: createApiClient({ baseUrl: "http://localhost", fetch: fetchStub }) };
    }
    const json = (status: number, body: unknown) => () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    function renderWithClient(client: ReturnType<typeof createApiClient>) {
      render(
        <SessionProvider session={sessionWith(["rn"])}>
          <MemoryRouter initialEntries={["/hope/assessments/hope-1"]}>
            <ApiClientProvider client={client}>
              <CompleteSfvDialog
                assessment={ASSESSMENT}
                api={client as unknown as SfvDialogApi}
                items={ITEMS}
                wordingChanged={false}
                onWordingChanged={() => undefined}
                onCancel={() => undefined}
                onCompleted={async () => undefined}
              />
            </ApiClientProvider>
          </MemoryRouter>
        </SessionProvider>,
      );
      return screen.getByRole("dialog", { name: "Complete SFV" });
    }

    it("retries a request that got no answer on the same Idempotency-Key", async () => {
      const { client, keys } = realClient([
        () => Promise.reject(new TypeError("Failed to fetch")),
        json(201, { id: "sfv-1" }),
      ]);
      const dialog = renderWithClient(client);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await within(dialog).findByRole("alert");
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(keys).toHaveLength(2));
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
    });

    it("starts the next attempt after an answered refusal on a new Idempotency-Key", async () => {
      const { client, keys } = realClient([
        json(409, { error: { code: "CONFLICT", message: "This SFV was already completed." } }),
        json(201, { id: "sfv-1" }),
      ]);
      const dialog = renderWithClient(client);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await within(dialog).findByRole("alert");
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(keys).toHaveLength(2));
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBeTruthy();
      expect(keys[1]).not.toBe(keys[0]);
    });
  });

  describe("the admission record is not available", () => {
    it("says so as a retryable condition, in the dialog's own words, and a retry can complete it", async () => {
      const post = vi
        .fn<SfvDialogApi["POST"]>()
        .mockResolvedValueOnce({
          error: { error: { code: "DEGRADED", message: "admission-seam: connection refused" } },
        })
        .mockResolvedValueOnce({ data: { id: "sfv-1" } });
      const { dialog, onCompleted } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));

      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(
        "The admission record is temporarily unavailable. Try again in a moment.",
      );
      expect(alert.textContent).not.toContain("connection refused");
      expect(submitButton(dialog).disabled).toBe(false);

      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
    });

    it("words an admission it cannot project in the module's own sentence, not the server's", async () => {
      // The server text for this code ends in advice about a NEW Idempotency-Key, which the clinician cannot act on.
      const message =
        "This admission has no election date. Send the request again with a NEW Idempotency-Key.";
      const post = vi.fn<SfvDialogApi["POST"]>(async () => ({
        error: { error: { code: "M10_ADMISSION_PROJECTION_GAP", message } },
      }));
      const { dialog } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toContain(ADMISSION_PROJECTION_GAP_MESSAGE);
      expect(alert.textContent).not.toContain("Idempotency-Key");
    });
  });

  describe("a failed submit", () => {
    const refusal = {
      error: { error: { code: "CONFLICT", message: "This SFV was already completed." } },
    };

    it.each([
      ["a refusal", vi.fn<SfvDialogApi["POST"]>(async () => refusal)],
      [
        "no answer",
        vi.fn<SfvDialogApi["POST"]>(async () => Promise.reject(new TypeError("offline"))),
      ],
    ])(
      "moves focus to the alert after %s, so Escape and Tab keep working inside the dialog",
      async (_name, post) => {
        const { dialog, onCancel } = renderDialog(["rn"], post);
        answerAndAttest(dialog);
        fireEvent.click(submitButton(dialog));

        const alert = await within(dialog).findByRole("alert");
        await waitFor(() => expect(document.activeElement).toBe(alert));
        expect(dialog.contains(document.activeElement)).toBe(true);
        // Escape from the alert reaches the dialog (a dirty form asks before closing).
        fireEvent.keyDown(alert, { key: "Escape" });
        expect(onCancel).not.toHaveBeenCalled();
        expect(within(dialog).getByText("Discard the answers you entered?")).toBeTruthy();
      },
    );

    it("shows the alert outside the scrolling body, directly above the footer buttons", async () => {
      const post = vi.fn<SfvDialogApi["POST"]>(async () => refusal);
      const { dialog } = renderDialog(["rn"], post);
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));

      const alert = await within(dialog).findByRole("alert");
      const body = within(dialog).getByRole("region", {
        name: /visit details and symptom reassessment/i,
      });
      expect(body.contains(alert)).toBe(false);
      expect(alert.nextElementSibling?.tagName).toBe("FOOTER");
    });
  });

  describe("while the completion is in flight", () => {
    it("cannot be cancelled by Cancel, Close, Escape or the backdrop, and keeps the typed draft", async () => {
      const reply = deferred<Reply>();
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "0" },
      });
      const { dialog, post, onCancel, onCompleted } = renderDialog(
        ["rn"],
        vi.fn<SfvDialogApi["POST"]>(() => reply.promise),
      );
      answerAndAttest(dialog);
      fireEvent.click(submitButton(dialog));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));

      const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      const close = within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(true);
      expect(close.disabled).toBe(true);
      fireEvent.click(cancel);
      fireEvent.click(close);
      fireEvent.keyDown(dialog, { key: "Escape" });
      pressBackdrop(dialog);
      expect(onCancel).not.toHaveBeenCalled();
      expect(peekStepUpDraft(DRAFT_KEY)).not.toBeNull();

      reply.resolve({ data: { id: "sfv-1" } });
      await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  describe("closing it", () => {
    const keepEditing = (dialog: HTMLElement) =>
      within(dialog).getByRole("button", { name: "Keep editing" });
    const question = "Discard the answers you entered?";
    /** Enter one answer, so the form holds something a close would lose. */
    const typeOneAnswer = (dialog: HTMLElement) =>
      fireEvent.click(within(dialog).getAllByRole("radio", { name: "Slight" })[0] as HTMLElement);

    it.each([
      [
        "Cancel",
        (dialog: HTMLElement) =>
          fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })),
      ],
      [
        "Close",
        (dialog: HTMLElement) =>
          fireEvent.click(within(dialog).getByRole("button", { name: "Close" })),
      ],
      ["Escape", (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: "Escape" })],
    ])("%s closes a form nothing was entered in at once", (_name, close) => {
      const { dialog, onCancel } = renderDialog(["rn"]);
      close(dialog);
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(within(dialog).queryByText(question)).toBeNull();
    });

    it.each([
      [
        "Cancel",
        (dialog: HTMLElement) =>
          fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })),
      ],
      [
        "Close",
        (dialog: HTMLElement) =>
          fireEvent.click(within(dialog).getByRole("button", { name: "Close" })),
      ],
      ["Escape", (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: "Escape" })],
    ])("%s asks before discarding entered answers, and Keep editing keeps them", (_name, close) => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1" },
      });
      const { dialog, onCancel } = renderDialog(["rn"]);
      close(dialog);

      expect(within(dialog).getByText(question)).toBeTruthy();
      expect(document.activeElement).toBe(keepEditing(dialog));
      expect(onCancel).not.toHaveBeenCalled();
      expect(peekStepUpDraft(DRAFT_KEY)).not.toBeNull();

      fireEvent.click(keepEditing(dialog));
      expect(within(dialog).queryByText(question)).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
      expect(within(dialog).getByText("1/2 completed")).toBeTruthy();
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("discards the entered answers and the stashed draft when the clinician chooses Discard", () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1", J2053B: "0" },
      });
      const { dialog, onCancel } = renderDialog(["rn"]);
      expect(within(dialog).getByText("2/2 completed")).toBeTruthy();

      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(peekStepUpDraft(DRAFT_KEY)).not.toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard" }));

      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(peekStepUpDraft(DRAFT_KEY)).toBeNull();
    });

    it("describes what Keep editing keeps, so the question is announced with its choice", () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1" },
      });
      const { dialog } = renderDialog(["rn"]);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      const id = keepEditing(dialog).getAttribute("aria-describedby");
      expect(document.getElementById(id as string)?.textContent).toMatch(/lose|discard/i);
    });

    it("puts focus back on the button that asked to close when nothing had focus (a mouse click in Safari)", () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1" },
      });
      const { dialog } = renderDialog(["rn"]);
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      const cancel = within(dialog).getByRole("button", { name: "Cancel" });
      fireEvent.click(cancel);
      expect(document.activeElement).toBe(keepEditing(dialog));

      fireEvent.click(keepEditing(dialog));
      expect(document.activeElement).toBe(cancel);
    });

    it("treats Escape while the question is showing as Keep editing", () => {
      const { dialog, onCancel } = renderDialog(["rn"]);
      typeOneAnswer(dialog);
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(within(dialog).getByText(question)).toBeTruthy();
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(within(dialog).queryByText(question)).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it("never closes from the backdrop", () => {
      const { dialog, onCancel } = renderDialog(["rn"]);
      pressBackdrop(dialog);
      expect(onCancel).not.toHaveBeenCalled();
      expect(within(dialog).queryByText(question)).toBeNull();
    });
  });

  describe("after a successful submit", () => {
    it("spends the stashed draft and reports the completion", async () => {
      stashStepUpDraft(DRAFT_KEY, {
        date: "2026-09-01",
        discipline: "RN",
        answers: { J2053A: "1", J2053B: "0" },
      });
      const { dialog, onCompleted, onCancel } = renderDialog(["rn"]);
      fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
      fireEvent.click(submitButton(dialog));

      await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
      expect(peekStepUpDraft(DRAFT_KEY)).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
    });
  });

  describe("without J2053 questions", () => {
    it("shows no progress bar and is not complete: there is nothing to attest to", () => {
      const { dialog, post } = renderDialog(["rn"], undefined, []);
      expect(within(dialog).queryByText(/completed$/)).toBeNull();
      expect(dialog.querySelector('[style*="NaN"]')).toBeNull();
      expect(within(dialog).queryByText(/Reassessment complete/)).toBeNull();
      expect(
        within(dialog).getByText("No reassessment questions are available for this record."),
      ).toBeTruthy();

      fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));
      expect(submitButton(dialog).disabled).toBe(true);
      fireEvent.click(submitButton(dialog));
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe("the visit date", () => {
    it("defaults to the clinician's local calendar day, not the UTC day", () => {
      const previousZone = process.env.TZ;
      process.env.TZ = "America/Los_Angeles";
      vi.useFakeTimers({ toFake: ["Date"] });
      // 03:30 UTC on 2 September is 8:30 pm on 1 September in Los Angeles.
      vi.setSystemTime(new Date("2026-09-02T03:30:00.000Z"));
      try {
        // The zone really changed (it does in a forked worker; in a thread worker process.env is a copy and does not move
        // the clock's zone): without this the test would pass on a UTC machine without proving anything.
        expect(new Date().getHours()).toBe(20);
        const { dialog } = renderDialog(["rn"]);
        expect((within(dialog).getByLabelText("SFV date") as HTMLInputElement).value).toBe(
          "2026-09-01",
        );
      } finally {
        vi.useRealTimers();
        // Assigning undefined would store the string "undefined" as the zone.
        if (previousZone === undefined) Reflect.deleteProperty(process.env, "TZ");
        else process.env.TZ = previousZone;
      }
    });
  });

  describe("layout and focus", () => {
    it("moves focus to the first field when it opens, not to Close", () => {
      const { dialog } = renderDialog(["rn"]);
      expect(document.activeElement).toBe(within(dialog).getByLabelText("SFV date"));
    });

    it("has one scrolling region: the body scrolls and the card adds nothing to scroll beside it", () => {
      const { dialog } = renderDialog(["rn"]);
      const scrolling = [...dialog.querySelectorAll<HTMLElement>("*")].filter((el) =>
        ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
      );
      expect(scrolling).toEqual([
        within(dialog).getByRole("region", { name: /visit details and symptom reassessment/i }),
      ]);
      // A border or padding on the card would make it taller than the frame inside it, so it would scroll too.
      expect(dialog.style.borderTop).toBe("");
      expect(dialog.style.padding).toBe("");
    });
  });
});
