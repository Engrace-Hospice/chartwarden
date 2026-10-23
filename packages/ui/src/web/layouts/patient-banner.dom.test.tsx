// Audit F-037: chart pages without another title expose the patient name as the page's <h1>.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PatientBanner } from "./regions";

describe("PatientBanner name", () => {
  it("is a level-1 heading when nameAsHeading is set", () => {
    render(<PatientBanner name="Jo Doe" nameAsHeading />);
    expect(screen.getByRole("heading", { level: 1, name: "Jo Doe" })).toBeTruthy();
  });

  it("is not a heading by default, so pages with their own h1 do not get two", () => {
    render(<PatientBanner name="Jo Doe" />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
