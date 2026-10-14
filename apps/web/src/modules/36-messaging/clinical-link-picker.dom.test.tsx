import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@wardenx/ui";
import axe from "axe-core";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLINICAL_LINKS_FLAG_KEY,
  type ClinicalLinkCandidate,
  type ClinicalLinkCandidateSource,
} from "./clinical-link-kinds";
import {
  ClinicalLinkPicker,
  ClinicalLinkTray,
  triggerIndex,
  useClinicalLinkPicker,
} from "./clinical-link-picker";
import { draftToRichBody } from "./draft-to-rich-body";
import { useDefaultClinicalLinkSource } from "./use-clinical-link-source";
import { MAX_DRAFT_CLINICAL_LINKS, useDraftClinicalLinks } from "./use-draft-clinical-links";

afterEach(cleanup);

const ids = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const candidate = (n: number): ClinicalLinkCandidate => ({
  kind: "medication",
  entityId: ids(n),
  label: `Drug ${n}`,
  detail: "active",
});

function sourceOf(
  items: readonly ClinicalLinkCandidate[],
  kinds: ClinicalLinkCandidateSource["kinds"] = ["medication", "assessment"],
) {
  const list = vi.fn().mockResolvedValue(items);
  return { source: { kinds, list } as ClinicalLinkCandidateSource, list };
}

function Harness({
  source,
  patientId = "p-1",
}: { source: ClinicalLinkCandidateSource; patientId?: string | null }) {
  const picker = useClinicalLinkPicker(patientId, source);
  const tray = useDraftClinicalLinks();
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div>
      <textarea aria-label="Message" ref={ref} />
      <ClinicalLinkTray links={tray.links} onRemove={tray.remove} />
      <ClinicalLinkPicker
        picker={picker}
        links={tray.links}
        disabled={false}
        onAdd={tray.add}
        onClosed={() => ref.current?.focus()}
      />
      <button type="button" onClick={() => picker.setOpen(true)}>
        open via trigger
      </button>
    </div>
  );
}

const idleApi = { GET: vi.fn() } as unknown as ApiClient;
const withApi = (ui: JSX.Element) => <ApiClientProvider client={idleApi}>{ui}</ApiClientProvider>;
const mount = (ui: JSX.Element, flag = true) =>
  render(
    withApi(
      <FeatureFlagProvider flags={{ [CLINICAL_LINKS_FLAG_KEY]: flag }}>{ui}</FeatureFlagProvider>,
    ),
  );

describe("clinical link picker", () => {
  it("is hidden when the tenant flag is off, there is no patient, or the source offers no kind", () => {
    const { source } = sourceOf([candidate(1)]);
    mount(<Harness source={source} />, false);
    expect(screen.queryByRole("button", { name: /Link record/ })).toBeNull();
    cleanup();

    mount(<Harness source={source} patientId={null} />);
    expect(screen.queryByRole("button", { name: /Link record/ })).toBeNull();
    cleanup();

    mount(<Harness source={sourceOf([], []).source} />);
    expect(screen.queryByRole("button", { name: /Link record/ })).toBeNull();
  });

  it("is hidden with no FeatureFlagProvider at all (fails closed)", () => {
    render(withApi(<Harness source={sourceOf([]).source} />));
    expect(screen.queryByRole("button", { name: /Link record/ })).toBeNull();
  });

  it("offers only the kinds the source can list", async () => {
    mount(<Harness source={sourceOf([], ["assessment"]).source} />);
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Assessment"]);
  });

  it("walks kind then record by keyboard, adds the link, and returns focus to the composer", async () => {
    const { source, list } = sourceOf([candidate(1), candidate(2)]);
    mount(<Harness source={source} />);
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));

    const kindBox = await screen.findByRole("combobox", { name: "Choose a record type" });
    expect(document.activeElement).toBe(kindBox);
    await userEvent.keyboard("{Enter}");
    const recordBox = await screen.findByRole("combobox", { name: "Find a medication" });
    expect(list).toHaveBeenCalledWith("medication", "p-1", expect.any(AbortSignal));
    await screen.findByRole("option", { name: /Drug 2/ });
    expect(recordBox.getAttribute("aria-activedescendant")).toBeTruthy();

    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("list", { name: "Linked records" }).textContent).toContain("Drug 2");
    expect(document.activeElement).toBe(screen.getByLabelText("Message"));
  });

  it("filters records by typing, and closes on Escape with focus back in the composer", async () => {
    mount(<Harness source={sourceOf([candidate(1), candidate(2)]).source} />);
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("option", { name: /Drug 1/ });

    await userEvent.keyboard("Drug 2");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Message"));
  });

  it("shows an error with Try again, and an empty state", async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce([]);
    mount(<Harness source={{ kinds: ["medication"], list }} />);
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    await userEvent.keyboard("{Enter}");

    expect((await screen.findAllByText("Records could not be loaded.")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No records to link.")).toBeTruthy();
  });

  it("does not link the same record twice", async () => {
    mount(<Harness source={sourceOf([candidate(1)]).source} />);
    for (let round = 0; round < 2; round++) {
      await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("option", { name: /Drug 1/ });
      await userEvent.keyboard("{Enter}");
    }

    expect(screen.getAllByRole("button", { name: /^Remove link to/ })).toHaveLength(1);
  });

  it("caps a message at 10 links in the UI", async () => {
    const all = Array.from({ length: 12 }, (_, i) => candidate(i + 1));
    mount(<Harness source={sourceOf(all).source} />);
    for (let i = 0; i < MAX_DRAFT_CLINICAL_LINKS; i++) {
      await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("option", { name: /Drug 1\b/ });
      await userEvent.keyboard(`${"{ArrowDown}".repeat(i)}{Enter}`);
    }

    expect(screen.getAllByRole("button", { name: /^Remove link to/ })).toHaveLength(10);
    expect(
      (screen.getByRole("button", { name: /Link record/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Link limit reached \(10 per message\)/)).toBeTruthy();
  });

  it("removes a link from the tray", async () => {
    mount(<Harness source={sourceOf([candidate(1)]).source} />);
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("option", { name: /Drug 1/ });
    await userEvent.keyboard("{Enter}");

    await userEvent.click(screen.getByRole("button", { name: /^Remove link to/ }));

    expect(screen.queryByRole("list", { name: "Linked records" })).toBeNull();
  });

  it("has no serious axe violations open or closed", async () => {
    mount(<Harness source={sourceOf([candidate(1)]).source} />);
    const run = async () =>
      (
        await axe.run(document.body, {
          rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
        })
      ).violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(await run()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("option", { name: /Drug 1/ });
    expect((await run()).map((v) => v.id)).toEqual([]);
  });
});

describe("triggerIndex", () => {
  it("finds a # or + typed at the start of a word", () => {
    expect(triggerIndex("", "#", 1)).toBe(0);
    expect(triggerIndex("see ", "see +", 5)).toBe(4);
    expect(triggerIndex("a\n", "a\n#", 3)).toBe(2);
  });
  it("ignores a mid-word symbol, a paste and other characters", () => {
    expect(triggerIndex("C", "C#", 2)).toBeNull();
    expect(triggerIndex("1", "1+", 2)).toBeNull();
    expect(triggerIndex("", "#x", 2)).toBeNull();
    expect(triggerIndex("", "@", 1)).toBeNull();
  });
});

describe("draftToRichBody with links", () => {
  it("appends the chosen links as clinicalLink nodes, ids only, even for an unformatted draft", () => {
    const body = draftToRichBody("please review", [], [{ kind: "medication", entityId: ids(1) }]);

    expect(body?.doc.content).toHaveLength(2);
    expect(JSON.stringify(body?.doc.content[1])).toBe(
      JSON.stringify({
        type: "paragraph",
        content: [{ type: "clinicalLink", kind: "medication", entityId: ids(1) }],
      }),
    );
  });
  it("keeps the plain-text path when there are no links", () => {
    expect(draftToRichBody("please review", [])).toBeNull();
  });
});

describe("default candidate source", () => {
  function SourceProbe({ onSource }: { onSource: (s: ClinicalLinkCandidateSource) => void }) {
    onSource(useDefaultClinicalLinkSource());
    return null;
  }
  const defaultSource = (api: unknown) => {
    let source: ClinicalLinkCandidateSource | undefined;
    render(
      <ApiClientProvider client={api as ApiClient}>
        <SourceProbe
          onSource={(s) => {
            source = s;
          }}
        />
      </ApiClientProvider>,
    );
    if (!source) throw new Error("no source");
    return source;
  };

  it("enables only the kinds that have an existing typed patient-scoped list route", () => {
    expect(defaultSource({ GET: vi.fn() }).kinds).toEqual([
      "assessment",
      "medication",
      "care_plan",
    ]);
  });

  it("lists assessments, medications and the care plan with GET only", async () => {
    const GET = vi.fn((path: string) => {
      if (path.endsWith("/assessments"))
        return Promise.resolve({
          data: {
            assessments: [{ id: ids(1), scaleType: "pps", capturedAt: "2026-10-01T00:00:00Z" }],
          },
        });
      if (path === "/api/v1/medication-orders")
        return Promise.resolve({
          data: {
            orders: [{ id: ids(2), drugName: "Morphine", strength: "5 mg", status: "active" }],
          },
        });
      return Promise.resolve({ data: undefined, response: { status: 404 } });
    });
    const POST = vi.fn();
    const source = defaultSource({ GET, POST, PUT: POST, PATCH: POST, DELETE: POST });
    const signal = new AbortController().signal;

    const assessments = await source.list("assessment", "p-1", signal);
    const medications = await source.list("medication", "p-1", signal);
    const carePlan = await source.list("care_plan", "p-1", signal);

    expect(assessments.map((a) => [a.entityId, a.label])).toEqual([[ids(1), "PPS"]]);
    expect(medications.map((m) => [m.entityId, m.label])).toEqual([[ids(2), "Morphine 5 mg"]]);
    expect(carePlan).toEqual([]);
    await waitFor(() => expect(POST).not.toHaveBeenCalled());
  });

  it("rejects when a list route fails", async () => {
    const source = defaultSource({
      GET: vi.fn().mockResolvedValue({ data: undefined, error: {}, response: { status: 500 } }),
    });

    await expect(
      source.list("assessment", "p-1", new AbortController().signal),
    ).rejects.toBeTruthy();
  });

  it("never shows one kind's records for another kind, and a reopen fetches nothing for the old step", async () => {
    let settleAssessments: (items: readonly ClinicalLinkCandidate[]) => void = () => {};
    const list = vi.fn((kind: string) =>
      kind === "medication"
        ? Promise.resolve([candidate(1)])
        : new Promise<readonly ClinicalLinkCandidate[]>((resolve) => {
            settleAssessments = resolve;
          }),
    );
    const source = { kinds: ["medication", "assessment"], list } as ClinicalLinkCandidateSource;
    mount(<Harness source={source} />);
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("option", { name: /Drug 1/ });

    await userEvent.keyboard("{Backspace}{ArrowDown}{Enter}");

    await screen.findByRole("combobox", { name: "Find a assessment" });
    expect(screen.queryByRole("option", { name: /Drug 1/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Loading records");
    settleAssessments([]);
    await screen.findByText("No records to link.");

    await userEvent.keyboard("{Escape}");
    const calls = list.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: /Link record/ }));
    await screen.findByRole("combobox", { name: "Choose a record type" });
    expect(list).toHaveBeenCalledTimes(calls);
  });
});
