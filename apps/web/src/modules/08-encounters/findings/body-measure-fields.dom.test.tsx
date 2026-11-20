import { Button } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import type { JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { BodyMeasureFields, useWeightHistory } from "./body-measure-fields";
import type { WeightHistoryView } from "./findings-api";
import { type BodyMeasureValues, EMPTY_BODY_MEASURES } from "./findings-model";
import {
  ENCOUNTER_ID,
  PATIENT_ID,
  WEIGHT_HISTORY_PATH,
  errorReply,
  mountWithApi,
} from "./findings-test-harness";

/** This year's November 4th, so the line reads "Nov 4" whichever year the suite runs in. */
const PRIOR_DATE = `${new Date().getFullYear()}-11-04`;

const HISTORY: WeightHistoryView = {
  patientId: PATIENT_ID,
  weightUnitMissing: false,
  current: null,
  prior: { value: "155", unit: "lb", on: PRIOR_DATE },
  history: [
    { value: "155", unit: "lb", on: PRIOR_DATE },
    { value: "158", unit: "lb", on: `${new Date().getFullYear()}-10-28` },
  ],
};

/** The vitals panel's role: it owns the values the fields edit. */
function Harness({
  initial = EMPTY_BODY_MEASURES,
  disabled,
  weightHistory,
  onChange,
}: {
  initial?: BodyMeasureValues;
  disabled?: boolean;
  weightHistory?: WeightHistoryView | null;
  onChange?: (next: BodyMeasureValues) => void;
}): JSX.Element {
  const [values, setValues] = useState(initial);
  return (
    <BodyMeasureFields
      values={values}
      disabled={disabled}
      weightHistory={weightHistory}
      onChange={(next) => {
        setValues(next);
        onChange?.(next);
      }}
    />
  );
}

const weight = () => screen.getByRole("textbox", { name: "Weight" });
const height = () => screen.getByRole("textbox", { name: "Height" });

describe("BodyMeasureFields", () => {
  it("labels the four fields and defaults to pounds and inches", () => {
    render(<Harness />);

    expect(weight()).toHaveValue("");
    expect(height()).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Weight unit" })).toHaveValue("lb");
    expect(screen.getByRole("combobox", { name: "Height unit" })).toHaveValue("in");
  });

  it("hands every change to the owner as the complete set of values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<BodyMeasureFields values={EMPTY_BODY_MEASURES} onChange={onChange} />);

    await user.type(weight(), "1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Height unit" }), "cm");

    expect(onChange).toHaveBeenNthCalledWith(1, { ...EMPTY_BODY_MEASURES, weight: "1" });
    expect(onChange).toHaveBeenNthCalledWith(2, { ...EMPTY_BODY_MEASURES, heightUnit: "cm" });
  });

  it("previews BMI as both measures are typed, and follows a change of unit", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(weight(), "152");
    expect(screen.queryByText(/^BMI/)).toBeNull();
    await user.type(height(), "64");
    expect(screen.getByText("BMI 26.1 (calculated from weight and height)")).toBeVisible();

    await user.clear(weight());
    expect(screen.queryByText(/^BMI/)).toBeNull();
  });

  it("previews BMI from metric measures", () => {
    render(
      <Harness initial={{ weight: "70", weightUnit: "kg", height: "175", heightUnit: "cm" }} />,
    );

    expect(screen.getByText("BMI 22.9 (calculated from weight and height)")).toBeVisible();
  });

  it("states the last visit's weight and the change, in plain words", async () => {
    const user = userEvent.setup();
    render(<Harness weightHistory={HISTORY} />);

    expect(screen.getByText("Last visit (Nov 4): 155 lb.")).toBeVisible();
    await user.type(weight(), "152");

    expect(screen.getByText("Last visit (Nov 4): 155 lb. Down 3 lb.")).toBeVisible();
  });

  it("compares in the unit being entered when it differs from the last visit's", async () => {
    const user = userEvent.setup();
    render(<Harness weightHistory={HISTORY} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Weight unit" }), "kg");
    await user.type(weight(), "70");

    // 155 lb is 70.3 kg.
    expect(screen.getByText("Last visit (Nov 4): 155 lb. Down 0.3 kg.")).toBeVisible();
  });

  it("shows no comparison when there is no earlier weight", () => {
    render(
      <Harness
        weightHistory={{
          patientId: PATIENT_ID,
          weightUnitMissing: false,
          current: null,
          prior: null,
          history: [],
        }}
      />,
    );

    expect(screen.queryByText(/Last visit/)).toBeNull();
  });

  it("names a weight that is not a positive number and previews no BMI from it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...EMPTY_BODY_MEASURES, height: "64" }} />);

    await user.type(weight(), "abc");

    expect(weight()).toBeInvalid();
    expect(weight()).toHaveAccessibleDescription("Enter the weight as a number greater than 0.");
    expect(screen.queryByText(/^BMI/)).toBeNull();
  });

  it("is read-only when disabled", () => {
    render(<Harness disabled initial={{ ...EMPTY_BODY_MEASURES, weight: "152" }} />);

    expect(weight()).toBeDisabled();
    expect(height()).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Weight unit" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Height unit" })).toBeDisabled();
    expect(weight()).toHaveValue("152");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <Harness
        weightHistory={HISTORY}
        initial={{ weight: "152", weightUnit: "lb", height: "64", heightUnit: "in" }}
      />,
    );

    const results = await axe.run(container);

    expect(results.violations).toEqual([]);
  });
});

function WeightHistoryProbe(): JSX.Element {
  const { weightHistory, error, reload } = useWeightHistory(ENCOUNTER_ID);
  return (
    <>
      <p>{weightHistory ? `prior ${weightHistory.prior?.value ?? "none"}` : "no history"}</p>
      <p>{error ?? "no error"}</p>
      <Button onClick={reload}>Reload</Button>
    </>
  );
}

describe("useWeightHistory", () => {
  it("reads the history of the encounter and reads again on reload", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { requests } = mountWithApi(<WeightHistoryProbe />, (request) => {
      if (request.path !== WEIGHT_HISTORY_PATH) return { status: 404, json: {} };
      reads += 1;
      return {
        json: { ...HISTORY, prior: { ...HISTORY.prior, value: reads === 1 ? "155" : "150" } },
      };
    });

    expect(await screen.findByText("prior 155")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reload" }));

    expect(await screen.findByText("prior 150")).toBeVisible();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${WEIGHT_HISTORY_PATH}`,
      `GET ${WEIGHT_HISTORY_PATH}`,
    ]);
  });

  it("reports a failed read in words and holds no history", async () => {
    mountWithApi(<WeightHistoryProbe />, () => errorReply(404, "NOT_FOUND", "encounter not found"));

    expect(await screen.findByText("That visit is no longer available to you.")).toBeVisible();
    expect(screen.getByText("no history")).toBeVisible();
  });
});
