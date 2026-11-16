// @vitest-environment jsdom
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { HopeRecordModal } from "../hope-record-modal";
import {
  EMPTY_SECTIONS,
  HopeRecordSections,
  type SectionChange,
  type SectionValues,
  applySectionChange,
} from "../hope-record-sections";
import { SESSION, ok } from "./workspace-test-kit";

// The recording dialog's I, J and N sections (hope-record-sections.tsx) as the dialog drives them: their values are reset when it opens
// again, and two changes in one batch both land.

afterEach(cleanup);

function mount() {
  const post = vi.fn(async () => ok({ id: "created" }));
  const client = {
    GET: vi.fn(async () => ok({})),
    POST: post,
  } as unknown as ApiClient;
  const view = (open: boolean) => (
    <SessionProvider session={SESSION}>
      <ApiClientProvider client={client}>
        <HopeRecordModal open={open} admissionId="adm-1" onClose={vi.fn()} onDone={vi.fn()} />
      </ApiClientProvider>
    </SessionProvider>
  );
  const rendered = render(view(true));
  const dialog = () => screen.getByRole("dialog", { name: "Record HOPE timepoint" });
  const severity = (symptom: string) =>
    within(dialog()).getByLabelText(symptom, { selector: "select" }) as HTMLSelectElement;
  const diagnosis = () =>
    within(dialog()).getByLabelText(/Primary terminal diagnosis/) as HTMLInputElement;
  return {
    post,
    dialog,
    severity,
    diagnosis,
    setOpen: (open: boolean) => rendered.rerender(view(open)),
  };
}

/** The sections alone, with a spy for onChange: the values never change, as when two handlers run before a re-render. */
function renderSections(values: SectionValues, changes: SectionChange[]): void {
  const client = { GET: vi.fn(async () => ok({})) } as unknown as ApiClient;
  render(
    <ApiClientProvider client={client}>
      <HopeRecordSections values={values} onChange={(change) => changes.push(change)} />
    </ApiClientProvider>,
  );
}

describe("the I, J and N values", () => {
  it("are cleared when the dialog is opened again", () => {
    const { dialog, severity, diagnosis, setOpen } = mount();
    fireEvent.change(diagnosis(), { target: { value: "C34.90" } });
    fireEvent.blur(diagnosis());
    fireEvent.change(severity("Pain"), { target: { value: "severe" } });
    fireEvent.click(within(dialog()).getByLabelText(/J2030 — screened for pain/));
    fireEvent.click(within(dialog()).getByLabelText(/Opioid prescribed for pain/));
    expect(diagnosis().value).toContain("C34.90");
    expect(severity("Pain").value).toBe("severe");

    setOpen(false);
    setOpen(true);

    expect(diagnosis().value).toBe("");
    expect(severity("Pain").value).toBe("");
    expect(
      (within(dialog()).getByLabelText(/J2030 — screened for pain/) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (within(dialog()).getByLabelText(/Opioid prescribed for pain/) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("keep both of two severities changed against the same render (one batch)", () => {
    // Two handlers that ran before the dialog re-rendered: each saw the SAME values. The changes they report must compose, not overwrite.
    const changes: SectionChange[] = [];
    renderSections(EMPTY_SECTIONS, changes);

    fireEvent.change(screen.getByLabelText("Pain", { selector: "select" }), {
      target: { value: "mild" },
    });
    fireEvent.change(screen.getByLabelText("Anxiety", { selector: "select" }), {
      target: { value: "severe" },
    });

    expect(changes).toHaveLength(2);
    const applied = changes.reduce(applySectionChange, EMPTY_SECTIONS);
    expect(applied.severities).toEqual({ pain: "mild", anxiety: "severe" });
  });

  it("drop a severity set back to not screened, whatever else is set", () => {
    const changes: SectionChange[] = [];
    const start = { ...EMPTY_SECTIONS, severities: { pain: "mild", anxiety: "severe" } } as const;
    renderSections(start, changes);

    fireEvent.change(screen.getByLabelText("Pain", { selector: "select" }), {
      target: { value: "" },
    });

    expect(changes.reduce(applySectionChange, start).severities).toEqual({ anxiety: "severe" });
  });

  it("send what was entered, and nothing of a previous use, with the capture", async () => {
    const { post, dialog, severity, setOpen } = mount();
    fireEvent.change(severity("Pain"), { target: { value: "severe" } });
    setOpen(false);
    setOpen(true);
    fireEvent.change(severity("Anxiety"), { target: { value: "mild" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Record draft" }));

    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, init] = post.mock.calls[0] as unknown as [string, { body: { data: unknown } }];
    expect(JSON.stringify(init.body.data)).toContain('"anxiety"');
    expect(JSON.stringify(init.body.data)).not.toContain('"pain"');
  });
});
