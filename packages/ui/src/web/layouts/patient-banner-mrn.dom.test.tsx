// The banner prints its own "MRN" label, so a stored identifier that already starts with the label ("MRN-FB250B6C6A8A", the format the
// patient service generates) must not repeat it: one label, then the identifier. Synthetic identifiers only.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PatientBanner } from "./regions";

/** The banner's MRN field as the reader sees it: the label, then the identifier ("MRN" + value; the gap between them is margin). */
function mrnField(): string | null {
  const label = screen.queryByText("MRN");
  return label?.parentElement?.textContent ?? null;
}

describe("PatientBanner MRN", () => {
  it.each([
    ["MRN-FB250B6C6A8A", "FB250B6C6A8A"],
    ["FB250B6C6A8A", "FB250B6C6A8A"],
    ["mrn 123", "123"],
    ["MRN: 123", "123"],
    ["  MRN-0042817 ", "0042817"],
    ["MRNX-1", "MRNX-1"],
  ])("shows the stored %s as one MRN label followed by %s", (stored, shown) => {
    render(<PatientBanner name="Emma Charlotte" mrn={stored} dob="1970-01-01" />);

    expect(mrnField()).toBe(`MRN${shown}`);
    expect(screen.getAllByText(/MRN/i)).toHaveLength(1 + (shown.includes("MRN") ? 1 : 0));
  });

  it("keeps the identifier in the monospace face", () => {
    render(<PatientBanner name="Emma Charlotte" mrn="MRN-FB250B6C6A8A" />);

    const identifier = screen.getByText("FB250B6C6A8A");
    expect(identifier.getAttribute("style")).toMatch(/font-family/);
  });

  it("shows no MRN field when nothing is left after the label", () => {
    render(<PatientBanner name="Emma Charlotte" mrn="MRN" dob="1970-01-01" />);

    expect(mrnField()).toBeNull();
    expect(screen.getByText("DOB")).toBeTruthy();
  });

  it("shows no MRN field when there is no MRN", () => {
    render(<PatientBanner name="Emma Charlotte" dob="1970-01-01" />);

    expect(mrnField()).toBeNull();
  });

  it("passes a caller's own element through untouched", () => {
    render(<PatientBanner name="Emma Charlotte" mrn={<em>MRN-1</em>} />);

    expect(screen.getByText("MRN-1")).toBeTruthy();
  });
});
