// @vitest-environment jsdom
// SlotInput ties the text a caller renders beside a control (`describedBy`) to the control, whichever kind of slot it is. The free-text
// branch used to ignore it. Without the prop no description is added, which is what the pain helper and the statement menu rely on.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SlotInput } from "./slot-input";

afterEach(cleanup);

const noop = (): void => undefined;

describe("SlotInput describedBy", () => {
  it("describes a free-text control by the caller's text", () => {
    render(
      <>
        <SlotInput
          slot="onset"
          spec={undefined}
          label="Onset"
          value=""
          disabled={false}
          describedBy="onset-note"
          onChange={noop}
        />
        <p id="onset-note">Recorded elsewhere</p>
      </>,
    );
    const control = screen.getByLabelText("Onset");
    expect(control).toHaveAttribute("aria-describedby", "onset-note");
    expect(control).toHaveAccessibleDescription("Recorded elsewhere");
  });

  it("describes a choice control by the caller's text", () => {
    render(
      <>
        <SlotInput
          slot="change"
          spec={{ kind: "choice", label: "Change", options: ["improved", "unchanged"] }}
          label="Change since the last visit"
          value=""
          disabled={false}
          describedBy="change-note"
          onChange={noop}
        />
        <p id="change-note">Recorded elsewhere</p>
      </>,
    );
    const control = screen.getByLabelText("Change since the last visit");
    expect(control).toHaveAttribute("aria-describedby", "change-note");
    expect(control).toHaveAccessibleDescription("Recorded elsewhere");
  });

  it("adds no description to a free-text control when the caller gives none", () => {
    render(
      <SlotInput
        slot="onset"
        spec={undefined}
        label="Onset"
        value=""
        disabled={false}
        onChange={noop}
      />,
    );
    expect(screen.getByLabelText("Onset")).not.toHaveAttribute("aria-describedby");
  });
});
