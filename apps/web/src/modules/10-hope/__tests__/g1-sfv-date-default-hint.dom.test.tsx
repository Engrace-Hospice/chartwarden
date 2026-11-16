// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { localToday } from "../hope-api";
import { SfvVisitDetails } from "../hope-sfv-dialog-parts";
import type { SfvForm } from "../hope-sfv-form";

// Group g1 (web-k3): the SFV date opens at today in the clinician's own zone and is sent as it stands. The field says so, beside it, until
// the clinician has entered a date (as the record dialog does for its visit date), so a visit on another day is not filed as today by
// not noticing. A date the clinician had already entered (restored after the step-up round trip) is not called a default.

afterEach(cleanup);

const HINT = "Set to today. Change it if the visit took place on another day.";

function Harness({ initialDate }: { initialDate: string }): JSX.Element {
  const [date, setDate] = useState(initialDate);
  const form = {
    date,
    setDate,
    authorRoles: ["RN"],
    discipline: "RN",
    setDiscipline: () => undefined,
  } as unknown as SfvForm;
  return <SfvVisitDetails form={form} saving={false} />;
}

describe("the SFV date field", () => {
  it("says it was set to today, and keeps its accessible name", () => {
    render(<Harness initialDate={localToday()} />);

    const input = screen.getByLabelText("SFV date");

    expect(screen.getByText(HINT)).toBeTruthy();
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText(HINT).id);
  });

  it("drops the hint once the clinician has entered a date (even today's again)", () => {
    render(<Harness initialDate={localToday()} />);

    fireEvent.change(screen.getByLabelText("SFV date"), { target: { value: "2026-01-05" } });
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.getByLabelText("SFV date").getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(screen.getByLabelText("SFV date"), { target: { value: localToday() } });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("does not call a date that was already entered a default", () => {
    render(<Harness initialDate="2026-01-05" />);

    expect(screen.queryByText(HINT)).toBeNull();
  });
});
