// The lab order's LOINC test code is picked from the M38 LOINC catalog (CodeSearchInput) while the order
// payload keeps its original shape: testCodes[0] = { system: "http://loinc.org", code, display }.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CanonicalOrderFields } from "./order-kind-fields";

function Harness({ client, seen }: { client: ApiClient; seen: Array<Record<string, unknown>> }) {
  const [value, setValue] = useState<Record<string, unknown>>({});
  return (
    <ApiClientProvider client={client}>
      <CanonicalOrderFields
        kind="lab"
        value={value}
        errors={{ testCodes: "Choose a test" }}
        onChange={(next) => {
          seen.push(next);
          setValue(next);
        }}
      />
    </ApiClientProvider>
  );
}

function clientWith(results: Array<{ code: string; display: string }>): ApiClient {
  return {
    GET: vi.fn(async (path: string) =>
      path.endsWith("/validate") ? { data: { valid: false } } : { data: { results } },
    ),
  } as unknown as ApiClient;
}

describe("lab order LOINC test code", () => {
  it("searches LOINC by name and stores the code with its real display", async () => {
    const seen: Array<Record<string, unknown>> = [];
    render(
      <Harness
        seen={seen}
        client={clientWith([
          { code: "3397-7", display: "Cocaine [Presence] in Urine" },
          { code: "3396-9", display: "Cocaine [Mass/volume] in Serum or Plasma" },
        ])}
      />,
    );
    const input = screen.getByRole("combobox", { name: /LOINC test code/ });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "cocaine" } });
    fireEvent.click(await screen.findByRole("option", { name: /3397-7/ }));
    expect(seen.at(-1)?.testCodes).toEqual([
      { system: "http://loinc.org", code: "3397-7", display: "Cocaine [Presence] in Urine" },
    ]);
    expect(screen.getByText("Choose a test")).toBeTruthy();
  });

  it("clears testCodes when the picker is cleared", async () => {
    const seen: Array<Record<string, unknown>> = [];
    render(<Harness seen={seen} client={clientWith([{ code: "3397-7", display: "Cocaine" }])} />);
    const input = screen.getByRole("combobox", { name: /LOINC test code/ });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "coc" } });
    fireEvent.click(await screen.findByRole("option", { name: /3397-7/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Clear LOINC code/ }));
    });
    await waitFor(() => expect(seen.at(-1)?.testCodes).toEqual([]));
  });

  it("keeps an unloaded-catalog code as entered, with the display falling back to the code", async () => {
    const seen: Array<Record<string, unknown>> = [];
    render(<Harness seen={seen} client={clientWith([])} />);
    const input = screen.getByRole("combobox", { name: /LOINC test code/ });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "2093-3" } });
    fireEvent.click(await screen.findByRole("option", { name: /as entered/ }));
    expect(seen.at(-1)?.testCodes).toEqual([
      { system: "http://loinc.org", code: "2093-3", display: "2093-3" },
    ]);
  });
});
