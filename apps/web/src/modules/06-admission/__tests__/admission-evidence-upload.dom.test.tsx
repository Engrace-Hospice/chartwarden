// @vitest-environment jsdom
// The NOR / Election Statement / CTI "Upload document" ceremonies in the right-hand drawer (shared scanned-upload
// kit): which fields each kind shows and that the handlers receive exactly what the old modal sent. The intake
// workspace opening it in place of the readiness rail is covered in admission-detail.dom.test.tsx.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  EvidenceUploadDrawer,
  type EvidenceUploadHandlers,
  type EvidenceUploadKind,
  type EvidenceUploadState,
} from "../admission-evidence-upload";

const STATE: EvidenceUploadState = {
  file: null,
  signedState: "unsigned",
  signerName: "",
  signerRole: "patient",
  signatureDate: "",
};

function handlers(): EvidenceUploadHandlers & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onFile: vi.fn(),
    onSignedState: vi.fn(),
    onSignerName: vi.fn(),
    onSignerRole: vi.fn(),
    onSignatureDate: vi.fn(),
  } as never;
}

function drawer(kind: EvidenceUploadKind, over: Partial<EvidenceUploadState> = {}, extra = {}) {
  const on = handlers();
  const onSubmit = vi.fn();
  const onClose = vi.fn();
  render(
    <EvidenceUploadDrawer
      kind={kind}
      state={{ ...STATE, ...over }}
      on={on}
      stage="idle"
      busy={false}
      error={null}
      onSubmit={onSubmit}
      onClose={onClose}
      {...extra}
    />,
  );
  return { on, onSubmit, onClose };
}

describe("EvidenceUploadDrawer", () => {
  it("NOR: just the document, in a drawer with a rail header", () => {
    const { on, onSubmit } = drawer("nor");
    const aside = screen.getByRole("complementary", { name: "Upload Notice of Rights" });
    expect(within(aside).queryByLabelText("Document signature status")).toBeNull();
    const file = new File(["%PDF"], "nor.pdf", { type: "application/pdf" });
    fireEvent.change(within(aside).getByLabelText(/^Document/), { target: { files: [file] } });
    expect(on.onFile).toHaveBeenCalledWith(file);
    fireEvent.click(within(aside).getByRole("button", { name: "Attach document" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("Election: a signed copy asks for the signer name, role and date", () => {
    const { on } = drawer("election", { signedState: "signed" });
    fireEvent.change(screen.getByLabelText(/Signer name/), { target: { value: "Elena Rivera" } });
    fireEvent.change(screen.getByLabelText("Signer role"), {
      target: { value: "legal_representative" },
    });
    fireEvent.change(screen.getByLabelText(/Signature date/), { target: { value: "2026-10-03" } });
    fireEvent.change(screen.getByLabelText("Document signature status"), {
      target: { value: "unsigned" },
    });
    expect(on.onSignerName).toHaveBeenCalledWith("Elena Rivera");
    expect(on.onSignerRole).toHaveBeenCalledWith("legal_representative");
    expect(on.onSignatureDate).toHaveBeenCalledWith("2026-10-03");
    expect(on.onSignedState).toHaveBeenCalledWith("unsigned");
  });

  it("signed Election upload is signed-only (no status choice)", () => {
    drawer("election-signed");
    expect(
      screen.getByRole("complementary", { name: "Upload signed Election Statement" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Document signature status")).toBeNull();
    expect(screen.getByLabelText(/Signer name/)).toBeTruthy();
  });

  it("CTI: a signed copy shows the hospice physician read-only and only the date", () => {
    drawer("cti", { signedState: "signed" }, { signedByLabel: "Dr. Amara Okafor" });
    expect(screen.getByText("Dr. Amara Okafor")).toBeTruthy();
    expect(screen.getByText("From admission details")).toBeTruthy();
    expect(screen.queryByLabelText(/Signer name/)).toBeNull();
    expect(screen.getByLabelText(/Signature date/)).toBeTruthy();
  });

  it("shows the upload stage and the server's refusal; Cancel closes", () => {
    const onClose = vi.fn();
    render(
      <EvidenceUploadDrawer
        kind="nor"
        state={STATE}
        on={handlers()}
        stage="verifying"
        busy={false}
        error="The uploaded document is not linked to this admission and patient."
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Verifying the upload…")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("not linked to this admission");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
