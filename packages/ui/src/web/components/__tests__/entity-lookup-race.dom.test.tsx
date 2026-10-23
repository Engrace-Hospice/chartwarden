// A slow earlier lookup response must never overwrite a later one (newest request wins).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntityLookupField } from "../entity-lookup-field";

type Result = { options: { id: string; label: string; searchLabel: string }[]; nextCursor: null };
const opt = (id: string, name: string): Result["options"][number] => ({
  id,
  label: name,
  searchLabel: name,
});

describe("EntityLookupField out-of-order responses", () => {
  it("keeps the later query's options when the earlier response lands last", async () => {
    let releaseSlow: (v: Result) => void = () => {};
    const slow = new Promise<Result>((r) => {
      releaseSlow = r;
    });
    const fast: Result = { options: [opt("2", "Okonkwo, Samuel")], nextCursor: null };
    const loadOptions = vi.fn((input: { query: string }) =>
      input.query === "" ? slow : Promise.resolve(fast),
    );
    render(
      <EntityLookupField label="Patient" value="" onChange={vi.fn()} loadOptions={loadOptions} />,
    );
    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.focus(input);
      await new Promise((r) => setTimeout(r, 250));
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Okonkwo" } });
      await new Promise((r) => setTimeout(r, 250));
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    await act(async () => {
      releaseSlow({
        options: [opt("1", "Whitfield, Eleanor"), opt("2", "Okonkwo, Samuel")],
        nextCursor: null,
      });
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText("Whitfield, Eleanor")).toBeNull();
  });
});
