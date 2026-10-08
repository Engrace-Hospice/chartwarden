// CodeSearchInput — the shared code type-ahead (ICD-10 / SNOMED CT / LOINC / CARC / RARC / RxNorm).
// Pins: search by code or description, `code – display` labels, keyboard navigation, the selected display
// surviving a re-render, clearing, loading/empty/error states, and the honest "use as entered" fallback that
// reports what /validate said.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../../core/api/client";
import { ApiClientProvider } from "../../../core/api/provider";
import { CodeSearchInput } from "../code-search-input";
import type { CodeSearchInputProps } from "../code-search-input";
import { normalizeCode, rankConcepts } from "../code-search-model";

const ICD_RESULTS = [
  { code: "I50.9", display: "Heart failure, unspecified" },
  { code: "I50", display: "Heart failure" },
  { code: "I50.84", display: "End stage heart failure" },
];

type GetFn = (path: string, init?: unknown) => Promise<unknown>;

function makeClient(get: GetFn): ApiClient {
  return { GET: vi.fn(get) } as unknown as ApiClient;
}

function calls(client: ApiClient): Array<[string, unknown]> {
  return (client.GET as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
}

function Harness(
  props: Partial<CodeSearchInputProps> & {
    client: ApiClient;
    onValue?: (c: string, d: string) => void;
  },
) {
  const { client, onValue, ...rest } = props;
  const [value, setValue] = useState(rest.value ?? "");
  return (
    <ApiClientProvider client={client}>
      <CodeSearchInput
        label="Primary diagnosis"
        system="icd10cm"
        {...rest}
        value={value}
        onChange={(code, display) => {
          setValue(code);
          onValue?.(code, display);
        }}
      />
    </ApiClientProvider>
  );
}

async function typeAndSettle(text: string) {
  const input = screen.getByRole("combobox", { name: /Primary diagnosis/ });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  return input;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CodeSearchInput", () => {
  it("searches by the typed term and ranks the exact code first", async () => {
    const client = makeClient(async () => ({ data: { results: ICD_RESULTS } }));
    render(<Harness client={client} />);
    await typeAndSettle("I50");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "I50Heart failure",
      "I50.84End stage heart failure",
      "I50.9Heart failure, unspecified",
    ]);
    const [path, init] = calls(client)[0]!;
    expect(path).toBe("/api/v1/terminology/{system}/search");
    expect(init).toMatchObject({ params: { path: { system: "icd10cm" }, query: { q: "I50" } } });
  });

  it("passes billableOnly and inValueSet through to the search route", async () => {
    const client = makeClient(async () => ({ data: { results: [] } }));
    render(<Harness client={client} system="loinc" billableOnly inValueSet="sud_test_loinc" />);
    await typeAndSettle("cocaine");
    expect(calls(client)[0]![1]).toMatchObject({
      params: { query: { billableOnly: true, inValueSet: "sud_test_loinc" } },
    });
  });

  it("debounces: a burst of keystrokes sends one request", async () => {
    const client = makeClient(async () => ({ data: { results: ICD_RESULTS } }));
    render(<Harness client={client} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    for (const text of ["I", "I5", "I50"]) {
      fireEvent.change(input, { target: { value: text } });
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
    }
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(client.GET).toHaveBeenCalledTimes(1);
  });

  it("selects with the keyboard and keeps the code with its display", async () => {
    const onValue = vi.fn();
    const client = makeClient(async () => ({ data: { results: ICD_RESULTS } }));
    render(<Harness client={client} onValue={onValue} />);
    const input = await typeAndSettle("heart");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/option-0$/);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onValue).toHaveBeenLastCalledWith("I50.84", "End stage heart failure");
    expect((input as HTMLInputElement).value).toBe("I50.84 – End stage heart failure");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("closes on Escape without selecting", async () => {
    const onValue = vi.fn();
    const client = makeClient(async () => ({ data: { results: ICD_RESULTS } }));
    render(<Harness client={client} onValue={onValue} />);
    const input = await typeAndSettle("heart");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onValue).not.toHaveBeenCalled();
  });

  it("clears the selection with the clear button", async () => {
    const onValue = vi.fn();
    const client = makeClient(async () => ({ data: { results: ICD_RESULTS } }));
    render(<Harness client={client} onValue={onValue} />);
    await typeAndSettle("heart");
    fireEvent.click(screen.getAllByRole("option")[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Clear ICD-10-CM code/ }));
    expect(onValue).toHaveBeenLastCalledWith("", "");
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
  });

  it("clears the code when the user edits a selected value", async () => {
    const onValue = vi.fn();
    const client = makeClient(async () => ({ data: { results: ICD_RESULTS } }));
    render(<Harness client={client} onValue={onValue} />);
    const input = await typeAndSettle("heart");
    fireEvent.click(screen.getAllByRole("option")[0]!);
    fireEvent.change(input, { target: { value: "I5" } });
    expect(onValue).toHaveBeenLastCalledWith("", "");
  });

  it("shows a searching state while the request is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    const client = makeClient(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<Harness client={client} />);
    await typeAndSettle("heart");
    expect(screen.getByText(/Searching ICD-10-CM/)).toBeTruthy();
    await act(async () => release({ data: { results: ICD_RESULTS } }));
    expect(screen.queryByText(/Searching ICD-10-CM/)).toBeNull();
  });

  it("ignores a stale response that arrives after a newer search", async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    const client = makeClient(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(<Harness client={client} />);
    const input = await typeAndSettle("he");
    fireEvent.change(input, { target: { value: "hea" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () =>
      resolvers[1]!({ data: { results: [{ code: "NEW", display: "Newer" }] } }),
    );
    await act(async () =>
      resolvers[0]!({ data: { results: [{ code: "OLD", display: "Older" }] } }),
    );
    const labels = screen.getAllByRole("option").map((o) => o.textContent);
    expect(labels).toContain("NEWNewer");
    expect(labels.some((l) => l?.includes("OLD"))).toBe(false);
  });

  it("offers a labelled use-as-entered row when the catalog has no match, and reports validate", async () => {
    const onValue = vi.fn();
    const client = makeClient(async (path) =>
      path.endsWith("/validate") ? { data: { valid: false } } : { data: { results: [] } },
    );
    render(<Harness client={client} onValue={onValue} />);
    await typeAndSettle("z99.9");
    expect(screen.getByText(/No ICD-10-CM matches in the catalog/)).toBeTruthy();
    const manual = screen.getByRole("option", { name: /as entered/ });
    expect(manual.textContent).toContain("Z99.9");
    await act(async () => {
      fireEvent.click(manual);
    });
    expect(onValue).toHaveBeenLastCalledWith("Z99.9", "");
    expect(screen.getByRole("status").textContent).toMatch(/Not found in the ICD-10-CM catalog/);
    const validateCall = calls(client).find(
      (c) => c[0] === "/api/v1/terminology/{system}/validate",
    );
    expect(validateCall?.[1]).toMatchObject({ params: { query: { code: "Z99.9" } } });
  });

  it("falls back to free-text entry when the search route errors", async () => {
    const onValue = vi.fn();
    const client = makeClient(async (path) =>
      path.endsWith("/validate") ? { data: { valid: true } } : { error: { message: "down" } },
    );
    render(<Harness client={client} system="snomed" onValue={onValue} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "84114007" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/SNOMED CT search is unavailable/);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onValue).toHaveBeenLastCalledWith("84114007", "");
    expect(screen.getByRole("status").textContent).toBe("Verified in SNOMED CT");
  });

  it("keeps a typed code on blur (uppercased for ICD-10) instead of dropping it", async () => {
    const onValue = vi.fn();
    const client = makeClient(async (path) =>
      path.endsWith("/validate") ? { data: { valid: true } } : { data: { results: [] } },
    );
    render(<Harness client={client} onValue={onValue} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: " c34.90 " } });
    await act(async () => {
      fireEvent.blur(input);
    });
    expect(onValue).toHaveBeenLastCalledWith("C34.90", "");
  });

  it("refuses an unknown code when allowUnverified is false", async () => {
    const onValue = vi.fn();
    const client = makeClient(async (path) =>
      path.endsWith("/validate") ? { data: { valid: false } } : { data: { results: [] } },
    );
    render(<Harness client={client} allowUnverified={false} onValue={onValue} />);
    const input = await typeAndSettle("ZZZ");
    expect(screen.queryByRole("option", { name: /as entered/ })).toBeNull();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onValue).not.toHaveBeenCalled();
  });

  it("looks up the description of a pre-filled code", async () => {
    vi.useRealTimers();
    const client = makeClient(async () => ({
      data: { code: "I50.84", display: "End stage heart failure" },
    }));
    render(<Harness client={client} value="I50.84" />);
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
        "I50.84 – End stage heart failure",
      ),
    );
  });

  it("wires label, required, error and disabled to the input", () => {
    const client = makeClient(async () => ({ data: { results: [] } }));
    render(<Harness client={client} required error="Enter a diagnosis" disabled />);
    const input = screen.getByRole("combobox", { name: /Primary diagnosis/ }) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-required")).toBe("true");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a diagnosis");
  });
});

describe("code-search-model", () => {
  it("normalizes case per system", () => {
    expect(normalizeCode("icd10cm", " i50.84 ")).toBe("I50.84");
    expect(normalizeCode("carc", "co-45")).toBe("CO-45");
    expect(normalizeCode("loinc", " 3397-7 ")).toBe("3397-7");
  });

  it("ranks exact code, then code prefix, then description prefix, then the rest", () => {
    const ranked = rankConcepts("hea", [
      { code: "X1", display: "Chronic heart" },
      { code: "HEA1", display: "Other" },
      { code: "X2", display: "Heart failure" },
    ]);
    expect(ranked.map((c) => c.code)).toEqual(["HEA1", "X2", "X1"]);
  });
});
