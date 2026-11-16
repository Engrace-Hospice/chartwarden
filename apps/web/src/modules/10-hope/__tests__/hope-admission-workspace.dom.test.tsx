// @vitest-environment jsdom
import { HOPE_ATTESTATION_VERSION } from "@chartwarden/types";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, type vi } from "vitest";
import {
  STEP_UP_REFUSAL,
  assessment,
  clientFor,
  item,
  renderWorkspace,
  review,
  useStubbedLocalStorage,
  workspace,
} from "./workspace-test-kit";

describe("Admission HOPE workspace", () => {
  useStubbedLocalStorage();

  it("renders backend-driven section navigation, prefill badges, and applicability states", async () => {
    renderWorkspace(clientFor());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );

    expect(screen.getByRole("button", { name: /A Administrative/ })).toBeTruthy();
    expect(screen.getByText("From admission")).toBeTruthy();
    // Guided mode shows one group at a time; the rail's sub-steps open the next one.
    fireEvent.click(screen.getByRole("button", { name: /^Patient Identity/ }));
    expect(screen.getByText("From patient chart")).toBeTruthy();
    const middleInitial = screen.queryByLabelText(/^Patient middle initial/) as HTMLInputElement;
    expect(middleInitial).toBeTruthy();
    expect(middleInitial.maxLength).toBe(1);
    expect(middleInitial.type).toBe("text");

    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    expect(screen.getByText("Skipped")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /J Health Conditions/ }));
    expect(
      screen.getByText(
        "This item is conditionally required and will open when the related answer is saved.",
      ),
    ).toBeTruthy();
  });

  it("autosaves editable answers with the backend workspace version", async () => {
    const client = clientFor();
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));

    await waitFor(() => expect(client.PATCH).toHaveBeenCalled());
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/hope/assessments/{id}/answers",
      expect.objectContaining({
        body: {
          ifVersion: 4,
          changes: [{ itemCode: "F2000A", action: "set", value: "1" }],
        },
      }),
    );
  });

  it("serializes the CMS caret option as its own explicit answer value '^', not a clear", async () => {
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A1005",
                label: "Ethnicity",
                options: [
                  {
                    valueCode: "^",
                    label: "Not assessed / skipped",
                    sortOrder: 1,
                  },
                  { valueCode: "1", label: "Hospice provider", sortOrder: 2 },
                ],
              }),
            ],
          },
        ],
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText(/^Ethnicity/), { target: { value: "^" } });

    await waitFor(() => expect(client.PATCH).toHaveBeenCalled());
    // The caret ("^", CMS "Dash — item not assessed") is a real, explicit HOPE answer code, distinct
    // from clearing the item entirely — the serializer only sends `action: "clear"` for `null`/`""`
    // (`hope-assessment-detail.tsx`'s `onCommit`), so selecting it PATCHes `action: "set", value: "^"`
    // like any other option, rather than clearing the answer.
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/hope/assessments/{id}/answers",
      expect.objectContaining({
        body: {
          ifVersion: 4,
          changes: [{ itemCode: "A1005", action: "set", value: "^" }],
        },
      }),
    );
  });

  it("shows a reload path on optimistic concurrency conflict", async () => {
    renderWorkspace(clientFor({ patchError: "version is stale" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
    fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));

    await waitFor(() =>
      expect(
        screen.getAllByText(
          "This assessment changed elsewhere. Reload the latest version before continuing.",
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getByRole("button", { name: "Reload assessment" })).toBeTruthy();
  });

  it.each([
    [
      "a stale version (the envelope the platform really sends)",
      409,
      {
        error: {
          code: "CONFLICT",
          message: "HOPE assessment hope-1 version is stale; reload and retry",
        },
      },
      true,
    ],
    [
      "a concurrent update",
      409,
      {
        error: {
          code: "CONCURRENT_UPDATE",
          message: "This step conflicted with another change in progress and was not applied.",
        },
      },
      true,
    ],
    [
      "a record that is no longer a draft",
      409,
      {
        error: {
          code: "CONFLICT",
          message: "HOPE assessment hope-1 is signed; only draft assessments can be edited",
        },
      },
      true,
    ],
    [
      "a value the server rejected",
      422,
      { error: { code: "VALIDATION_ERROR", message: "HOPE item is inactive for this ISC" } },
      false,
    ],
  ])(
    "tells %s apart: the conflict banner only for a conflict",
    async (_name, status, body, conflict) => {
      const client = clientFor();
      (client.PATCH as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: undefined,
        error: body,
        response: new Response(null, { status }),
      });
      renderWorkspace(client);
      await screen.findByRole("heading", { name: "Admission Workspace" });
      fireEvent.click(screen.getByRole("button", { name: /F Preferences/ }));
      fireEvent.click(screen.getByLabelText("Yes, discussion occurred"));

      const conflictText =
        "This assessment changed elsewhere. Reload the latest version before continuing.";
      // A refusal that is not a conflict shows the server's own words (the fixed "check the value" blamed the value for refusals that
      // were not about it).
      const plainText = "HOPE item is inactive for this ISC";
      await waitFor(() =>
        expect(screen.getAllByText(conflict ? conflictText : plainText).length).toBeGreaterThan(0),
      );
      expect(screen.queryAllByText(conflict ? plainText : conflictText)).toHaveLength(0);
      expect(Boolean(screen.queryByRole("button", { name: "Reload assessment" }))).toBe(conflict);
    },
  );

  const readyToSignReview = () =>
    review({
      validation: {
        errorCount: 0,
        warningCount: 1,
        hasBlockingErrors: false,
        findings: [],
      },
      readiness: { readyToSign: true, blockers: [] },
    });

  /** Open the Sign dialog of a ready-to-sign draft. */
  async function openSignDialog(client: ApiClient): Promise<HTMLElement> {
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Sign & complete" })[0]!);
    return screen.getByRole("dialog", { name: "Complete Admission" });
  }

  const attestSign = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /I attest/ }));

  it("uses backend readiness for Review and Sign", async () => {
    const client = clientFor({ review: readyToSignReview() });
    const dialog = await openSignDialog(client);
    expect(dialog).toBeTruthy();
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/hope/assessments/{id}/sign",
        expect.objectContaining({
          body: {
            ifVersion: 4,
            attestationConfirmed: true,
            attestationVersion: HOPE_ATTESTATION_VERSION,
          },
        }),
      ),
    );
  });

  it("R-05 — Sign cannot be sent until the attestation is ticked", async () => {
    const client = clientFor({ review: readyToSignReview() });
    const dialog = await openSignDialog(client);
    const sign = within(dialog).getByRole("button", {
      name: "Sign & complete",
    }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
    fireEvent.click(sign);
    expect(client.POST).not.toHaveBeenCalled();
    attestSign(dialog);
    expect(sign.disabled).toBe(false);
  });

  it("R-05 — a stale step-up on Sign redirects to /step-up with this record as returnTo", async () => {
    const client = clientFor({ review: readyToSignReview(), postError: STEP_UP_REFUSAL });
    const dialog = await openSignDialog(client);
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    const where = await screen.findByLabelText("step-up location");
    expect(where.textContent).toBe(
      `/step-up?returnTo=${encodeURIComponent("/hope/assessments/hope-1")}`,
    );
  });

  it("refuses a changed attestation wording outright, and claims nothing was signed", async () => {
    const client = clientFor({
      review: readyToSignReview(),
      postError: {
        error: {
          code: "M10_ATTESTATION_STALE",
          message: "Attestation version 2020-01-01.1 is not current.",
        },
      },
    });
    const dialog = await openSignDialog(client);
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "The attestation wording has changed. Reload the page and review it again.",
    );
    expect(within(dialog).queryByRole("button", { name: /retry|try again/i })).toBeNull();
    const sign = within(dialog).getByRole("button", {
      name: "Sign & complete",
    }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
    fireEvent.click(sign);
    expect(client.POST).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("step-up location")).toBeNull();
  });

  describe("a Sign that fails for a reason the server did not give", () => {
    const SIGN_UNCONFIRMED =
      "Could not confirm that the assessment was signed. Reload the record before trying again.";
    const reply = (status: number, error?: unknown) => ({
      data: undefined,
      error,
      response: new Response(null, { status }),
    });

    async function signWith(answer: unknown): Promise<HTMLElement> {
      const client = clientFor({ review: readyToSignReview() });
      (client.POST as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(answer);
      const dialog = await openSignDialog(client);
      attestSign(dialog);
      fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
      return within(dialog).findByRole("alert");
    }

    it("says a 503 DEGRADED is a service that is temporarily unavailable, in the dialog's own words", async () => {
      const alert = await signWith(
        reply(503, { error: { code: "DEGRADED", message: "admission-seam: connection refused" } }),
      );
      expect(alert.textContent).toBe(
        "The record could not be signed because a service it needs is temporarily unavailable. Try again in a moment.",
      );
    });

    it("does not show a server fault's raw text, and does not say nothing was signed", async () => {
      const alert = await signWith(
        reply(500, { error: { code: "INTERNAL", message: "ECONNREFUSED 10.0.0.5:5432 pg_pool" } }),
      );
      expect(alert.textContent).toBe(
        "The server could not complete the request, so the result could not be confirmed. Check the record before repeating the action.",
      );
    });

    it.each([
      ["no error at all", undefined],
      ["an empty error body", ""],
    ])("calls a 4xx with %s a refusal, not an unconfirmed signature", async (_name, error) => {
      const alert = await signWith(reply(403, error));
      expect(alert.textContent).toContain("The server refused the request without saying why.");
      expect(alert.textContent).not.toMatch(/could not confirm/i);
    });

    it.each([
      ["a gateway error with no body", reply(502)],
      ["an empty body that carries no status", { data: undefined, error: undefined }],
    ])("keeps %s as an unconfirmed result", async (_name, answer) => {
      expect((await signWith(answer)).textContent).toBe(SIGN_UNCONFIRMED);
    });
  });

  it("shows any other Sign failure in the dialog instead of silently closing it", async () => {
    const client = clientFor({
      review: readyToSignReview(),
      postError: { error: { code: "FORBIDDEN", message: "Your role cannot sign this record." } },
    });
    const dialog = await openSignDialog(client);
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Your role cannot sign this record.");
    expect(screen.queryByLabelText("step-up location")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Complete Admission" })).toBeTruthy();
  });

  it("says the signature may have gone through when the request never gets an answer", async () => {
    const client = clientFor({ review: readyToSignReview() });
    (client.POST as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const dialog = await openSignDialog(client);
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe(
      "Could not confirm that the assessment was signed. Reload the record before trying again.",
    );
    // Not stuck on "Signing...", and focus is on the alert so Escape and Tab still work inside the dialog.
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });

  it("keeps the Sign dialog open while the signature is in flight, so the refusal that follows is shown", async () => {
    const client = clientFor({ review: readyToSignReview() });
    let refuse: (reply: unknown) => void = () => undefined;
    // The client's generic signature is too deep for `vi.mocked`; it is a plain `vi.fn` here.
    (client.POST as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          refuse = resolve;
        }),
    );
    const dialog = await openSignDialog(client);
    attestSign(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign & complete" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));

    const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Complete Admission" })).toBeTruthy();

    refuse({
      data: undefined,
      error: { error: { code: "FORBIDDEN", message: "Your role cannot sign this record." } },
      response: new Response(null, { status: 403 }),
    });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("Your role cannot sign this record.");
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("marks Review complete for a completed HOPE assessment", async () => {
    const client = clientFor({
      assessment: {
        ...assessment,
        status: "signed",
        signedAt: "2026-09-08T14:00:00.000Z",
      },
    });
    renderWorkspace(client);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Review — Completed" })).toBeTruthy(),
    );
  });
  it("guides one group at a time with Back / Next naming the destination", async () => {
    renderWorkspace(clientFor());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    expect(screen.getByText("Step 1 of 2")).toBeTruthy();
    expect(screen.queryByLabelText(/^Patient middle initial/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Next: Patient Identity/ }));
    expect(screen.getByLabelText(/^Patient middle initial/)).toBeTruthy();
    expect(screen.getByText("Step 2 of 2")).toBeTruthy();

    // The last group of A continues into the next section.
    fireEvent.click(screen.getByRole("button", { name: /Next: F\. Preferences/ }));
    expect(screen.getByRole("heading", { name: "F. Preferences & Goals" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back: A\. Administrative/ }));
    expect(screen.getByLabelText(/^Patient middle initial/)).toBeTruthy();
  });

  it("offers Show all as a switch that reports its state once, through the native checkbox", async () => {
    renderWorkspace(clientFor());
    const toggle = (await screen.findByRole("switch", { name: /Show all/ })) as HTMLInputElement;
    expect(toggle.type).toBe("checkbox");
    expect(toggle.hasAttribute("aria-checked")).toBe(false);
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
  });

  it("Show all renders every section on one page and remembers the choice", async () => {
    renderWorkspace(clientFor());
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("switch", { name: /Show all/ }));

    expect(screen.getByRole("heading", { name: "All sections" })).toBeTruthy();
    expect(screen.getByText("From admission")).toBeTruthy();
    expect(screen.getByText("From patient chart")).toBeTruthy();
    expect(screen.getByLabelText("Yes, discussion occurred")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Jump to section" })).toBeTruthy();
    expect(window.localStorage.getItem("wx.hope.navMode")).toBe("all");
  });

  it("holds back 'required' errors until the user has moved past the group", async () => {
    const base = review();
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({ itemCode: "A0500A", label: "First name", value: "Ada", state: "answered" }),
              item({
                itemCode: "A1805",
                label: "Admitted from",
                options: [{ valueCode: "01", label: "Home", sortOrder: 1 }],
              }),
            ],
          },
        ],
      }),
      review: {
        ...base,
        validation: {
          ...base.validation,
          findings: [
            {
              ruleId: "CMS-HOPE-REQUIRED",
              severity: "error",
              section: "A",
              itemCode: "A1805",
              message: "A1805 is required for final HOPE validation.",
            },
          ],
        },
      },
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Living Situation/ }));
    expect(screen.queryByText("A1805 is required for final HOPE validation.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Back: Patient Identity/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next: Living Situation/ }));
    expect(screen.getByText("A1805 is required for final HOPE validation.")).toBeTruthy();
  });

  it("greys out choices a selected exclusive option rules out", async () => {
    const tile = (itemCode: string, label: string, value: string | null) =>
      item({
        itemCode,
        label,
        value,
        state: value ? "answered" : "unanswered",
        options: [
          { valueCode: "0", label: "Not checked", sortOrder: 1 },
          { valueCode: "1", label: "Checked", sortOrder: 2 },
        ],
      });
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              tile("A1010A", "White", "0"),
              tile("A1010B", "Black or African American", "0"),
              tile("A1010Z", "None of the above", "1"),
              item({
                itemCode: "A0700",
                label: "Patient Medicaid number",
                cmsItemTypeCode: "Text",
                value: "N",
                state: "answered",
                options: [
                  { valueCode: "Text", label: "Medicaid number", sortOrder: 1 },
                  { valueCode: "+", label: "Pending", sortOrder: 2 },
                  { valueCode: "N", label: "Not a Medicaid recipient", sortOrder: 3 },
                ],
              }),
            ],
          },
        ],
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("switch", { name: /Show all/ }));

    expect((screen.getByRole("checkbox", { name: /White/ }) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("checkbox", { name: /None of the above/ }) as HTMLInputElement).disabled,
    ).toBe(false);
    // A special value ("N") greys out the typed-value box; the others stay selectable.
    expect((screen.getByLabelText(/^Patient Medicaid number/) as HTMLInputElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByLabelText("Not a Medicaid recipient"));
    await waitFor(() => expect(client.PATCH).toHaveBeenCalled());
    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/hope/assessments/{id}/answers",
      expect.objectContaining({
        body: { ifVersion: 4, changes: [{ itemCode: "A0700", action: "clear" }] },
      }),
    );
  });

  it("renders CMS check-all items with a skip-pattern value as checkboxes, labels without the shared prefix", async () => {
    const painItem = (itemCode: string, label: string) =>
      item({
        itemCode,
        label,
        section: "J",
        group: "Pain",
        options: [
          { valueCode: "0", label: "Not checked (No)", sortOrder: 1 },
          { valueCode: "1", label: "Checked (Yes)", sortOrder: 2 },
          { valueCode: "^", label: "Blank (skip pattern)", sortOrder: 3 },
        ],
      });
    const client = clientFor({
      workspace: workspace({
        sections: [
          {
            code: "J",
            label: "Health Conditions",
            items: [
              painItem("J0910C1", "Pain asmt included: location"),
              painItem("J0910C2", "Pain asmt included: severity"),
              painItem("J0910C9", "Pain asmt included: none of the above"),
            ],
          },
        ],
      }),
    });
    renderWorkspace(client);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Admission Workspace" })).toBeTruthy(),
    );
    const group = screen.getByRole("group", { name: /^Pain assessment included/ });
    expect(within(group).getAllByRole("checkbox")).toHaveLength(3);
    expect(within(group).getByRole("checkbox", { name: /^Location/ })).toBeTruthy();
    expect(screen.queryByText("Not checked (No)")).toBeNull();
    expect(screen.queryByText(/Pain asmt included/)).toBeNull();
  });
  describe("A0600B Medicare number vs the patient's chart", () => {
    const medicareWorkspace = (value: string, source = "user") =>
      workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A0600B",
                label: "Patient Medicare number",
                cmsItemTypeCode: "Text",
                value,
                source,
                state: "answered",
                options: [{ valueCode: "Text", label: "Medicare number", sortOrder: 1 }],
              }),
            ],
          },
        ],
      });
    const medicarePayer = (subscriberId: string) => ({
      coverageKind: "medicare_ffs",
      subscriberId,
      rank: 1,
      current: true,
    });

    it("shows the Medicare coverage number in Patient Summary when the chart has no MBI identifier", async () => {
      renderWorkspace(
        clientFor({
          workspace: medicareWorkspace("1EG4TE5MK73"),
          payers: [medicarePayer("1EG4-TE5-MK73")],
        }),
      );
      await waitFor(() => expect(screen.getByText("...MK73")).toBeTruthy());
      // Same number (separators ignored): no chart note.
      expect(screen.queryByText(/Not on the patient's chart/)).toBeNull();
      expect(screen.queryByText(/Differs from the chart/)).toBeNull();
    });

    it("flags a typed number the chart does not have and offers to add it as coverage", async () => {
      renderWorkspace(clientFor({ workspace: medicareWorkspace("1EG4TE5MK73") }));
      await waitFor(() => expect(screen.getByText(/Not on the patient's chart/)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Reconcile…" }));
      const dialog = screen.getByRole("dialog", { name: "Reconcile Medicare number" });
      expect(within(dialog).getByText("Add it to the patient's chart")).toBeTruthy();
      // A payer must be chosen before the coverage can be filed.
      expect(
        (within(dialog).getByRole("button", { name: "Add to chart" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    });

    it("warns when the typed number differs from the chart's", async () => {
      renderWorkspace(
        clientFor({
          workspace: medicareWorkspace("1EG4TE5MK73"),
          identifiers: [{ kind: "mbi", value: "9AA9AA9AA99", last4: "AA99", effectiveTo: null }],
        }),
      );
      await waitFor(() => expect(screen.getByText(/Differs from the chart/)).toBeTruthy());
      expect(screen.getByText(/Differs from the chart \(…AA99\)/)).toBeTruthy();
    });

    it("adds no note when the value came from the chart itself", async () => {
      // The heading shows before the chart numbers are read, and a note can only show after them, so an absence checked at the
      // heading proves nothing. The chart holds a DIFFERENT number (a typed value would be flagged), and the Patient Summary's
      // last four is what says the read has landed.
      renderWorkspace(
        clientFor({
          workspace: medicareWorkspace("1EG4TE5MK73", "patient_prefill"),
          payers: [medicarePayer("9AA9AA9AA99")],
        }),
      );
      await waitFor(() => expect(screen.getByText("...AA99")).toBeTruthy());
      expect(screen.queryByText(/Not on the patient's chart/)).toBeNull();
      expect(screen.queryByText(/Differs from the chart/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Reconcile…" })).toBeNull();
    });
  });
  describe("A0600A SSN (CMS format edits)", () => {
    const ssnWorkspace = () =>
      workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A0600A",
                label: "Social Security Number",
                cmsItemTypeCode: "Text",
                maxLength: 9,
                options: [
                  { valueCode: "Text", label: "Patient social security number", sortOrder: 1 },
                  { valueCode: "^", label: "Blank (not available or unknown)", sortOrder: 2 },
                ],
              }),
            ],
          },
        ],
      });

    it("saves a dashed SSN as the 9 bare digits CMS expects", async () => {
      const client = clientFor({ workspace: ssnWorkspace() });
      renderWorkspace(client);
      const box = (await screen.findByLabelText(/^Social Security Number/)) as HTMLInputElement;
      fireEvent.change(box, { target: { value: "909-67-3453" } });
      fireEvent.blur(box);
      await waitFor(() =>
        expect(client.PATCH).toHaveBeenCalledWith(
          "/api/v1/hope/assessments/{id}/answers",
          expect.objectContaining({
            body: {
              ifVersion: 4,
              changes: [{ itemCode: "A0600A", action: "set", value: "909673453" }],
            },
          }),
        ),
      );
    });

    it("flags an SSN CMS would reject while it is typed", async () => {
      renderWorkspace(clientFor({ workspace: ssnWorkspace() }));
      const box = await screen.findByLabelText(/^Social Security Number/);
      fireEvent.change(box, { target: { value: "000123456" } });
      expect(screen.getByText(/SSN cannot start with 000\. \(CMS edit -3002\)/)).toBeTruthy();
      fireEvent.change(box, { target: { value: "123456789" } });
      expect(screen.getByText(/placeholder CMS rejects/)).toBeTruthy();
    });
  });
  describe("Reconciling A0600B with the chart", () => {
    const workspaceWith = (value: string, source = "user") =>
      workspace({
        sections: [
          {
            code: "A",
            label: "Administrative",
            items: [
              item({
                itemCode: "A0600B",
                label: "Patient Medicare number",
                cmsItemTypeCode: "Text",
                value,
                source,
                state: "answered",
                options: [{ valueCode: "Text", label: "Medicare number", sortOrder: 1 }],
              }),
            ],
          },
        ],
      });
    const coverage = {
      id: "pp-1",
      payerId: "payer-cms",
      rank: 1,
      coverageKind: "medicare_ffs",
      subscriberId: "9AA9AA9AA99",
      groupNumber: null,
      binPcn: null,
      current: true,
      effectiveFrom: "2026-10-04",
      effectiveTo: null,
    };

    it("uses the chart's number in HOPE", async () => {
      const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
      renderWorkspace(client);
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      fireEvent.click(screen.getByRole("button", { name: "Use the chart's number in HOPE" }));
      await waitFor(() =>
        expect(client.PATCH).toHaveBeenCalledWith(
          "/api/v1/hope/assessments/{id}/answers",
          expect.objectContaining({
            body: {
              ifVersion: 4,
              changes: [{ itemCode: "A0600B", action: "set", value: "9AA9AA9AA99" }],
            },
          }),
        ),
      );
    });

    it("re-files the chart's coverage with the HOPE number, keeping its payer, rank and dates", async () => {
      const client = clientFor({ workspace: workspaceWith("1EG4TE5MK73"), payers: [coverage] });
      renderWorkspace(client);
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      fireEvent.click(screen.getByRole("button", { name: "Update the chart" }));
      await waitFor(() =>
        expect(client.POST).toHaveBeenCalledWith(
          "/api/v1/patients/{id}/payers",
          expect.objectContaining({
            body: {
              payerId: "payer-cms",
              rank: 1,
              coverageKind: "medicare_ffs",
              subscriberId: "1EG4TE5MK73",
              groupNumber: null,
              binPcn: null,
              effectiveFrom: "2026-10-04",
            },
          }),
        ),
      );
    });

    it("will not put an invalid MBI on the chart", async () => {
      renderWorkspace(clientFor({ workspace: workspaceWith("A12B4590N1ZW"), payers: [coverage] }));
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      expect(screen.queryByRole("button", { name: "Update the chart" })).toBeNull();
      expect(screen.getByText(/cannot go on the\s+chart/)).toBeTruthy();
    });

    it("points to the patient chart when the chart's MBI is a patient identifier", async () => {
      renderWorkspace(
        clientFor({
          workspace: workspaceWith("1EG4TE5MK73"),
          identifiers: [{ kind: "mbi", value: "9AA9AA9AA99", last4: "AA99", effectiveTo: null }],
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      expect(screen.queryByRole("button", { name: "Update the chart" })).toBeNull();
      expect(screen.getByRole("link", { name: "patient chart" })).toBeTruthy();
    });

    it("saves the member-card number in HOPE and on the chart when neither is right", async () => {
      const client = clientFor({
        workspace: workspaceWith("A12B4590N1ZW"),
        payers: [{ ...coverage, subscriberId: "JU4877GDHJ" }],
      });
      renderWorkspace(client);
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      const save = screen.getByRole("button", { name: "Save the correct number" });
      const input = screen.getByRole("textbox", { name: "Correct Medicare number" });
      fireEvent.change(input, { target: { value: "1EG4-TE5-MK73x" } });
      expect(screen.getByText("Not a valid MBI.")).toBeTruthy();
      expect((save as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(input, { target: { value: "1eg4-te5-mk73" } });
      fireEvent.click(save);
      await waitFor(() =>
        expect(client.POST).toHaveBeenCalledWith(
          "/api/v1/patients/{id}/payers",
          expect.objectContaining({
            body: expect.objectContaining({ payerId: "payer-cms", subscriberId: "1EG4TE5MK73" }),
          }),
        ),
      );
      expect(client.PATCH).toHaveBeenCalledWith(
        "/api/v1/hope/assessments/{id}/answers",
        expect.objectContaining({
          body: {
            ifVersion: 4,
            changes: [{ itemCode: "A0600B", action: "set", value: "1EG4TE5MK73" }],
          },
        }),
      );
      expect(
        await screen.findByText("The Medicare number is saved in HOPE and on the chart."),
      ).toBeTruthy();
    });

    it("flags a number copied into a correction draft", async () => {
      renderWorkspace(
        clientFor({
          workspace: workspaceWith("A12B4590N1ZW", "correction_copy"),
          payers: [coverage],
        }),
      );
      expect(await screen.findByRole("button", { name: "Reconcile…" })).toBeTruthy();
    });

    it("sends a signed record to its open correction draft", async () => {
      const signed = { ...assessment, status: "signed", signedAt: "2026-09-08T14:00:00.000Z" };
      renderWorkspace(
        clientFor({
          assessment: signed,
          workspace: workspaceWith("A12B4590N1ZW"),
          payers: [coverage],
          timeline: [
            signed,
            { ...assessment, id: "hope-2", status: "draft", correctsAssessmentId: "hope-1" },
          ],
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
      const dialog = screen.getByRole("dialog", { name: "Reconcile Medicare number" });
      expect(within(dialog).getByRole("button", { name: "Open correction draft" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Create correction" })).toBeNull();
    });
  });
});
