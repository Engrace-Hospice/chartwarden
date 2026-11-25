// @vitest-environment jsdom
// The composer's advisory ESAS-r symptom prompt (Right Panel, beside "Scores and trend"). One sourced rule: an ESAS-r item scoring 4 or
// more of 10 in the latest reading up to the visit is listed with "consider a fuller assessment of this symptom". It is a prompt, not a
// finding: no severity tier, no total band, no "notify the physician" wording, no button, and nothing it does blocks the note. The
// readings come over the real typed client against a stub of the series route. Synthetic data only.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ComposerScoreTrend } from "./composer-score-trend";
import { EsasSymptomPrompt } from "./esas-symptom-prompt";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SERVICE_DATE = "2026-08-27";
const VISIT_TIME = "2026-08-27T15:00:00.000Z";

const ZEROS = {
  pain: 0,
  tiredness: 0,
  drowsiness: 0,
  nausea: 0,
  lackOfAppetite: 0,
  shortnessOfBreath: 0,
  depression: 0,
  anxiety: 0,
  wellbeing: 0,
};
type Items = typeof ZEROS;
const items = (patch: Partial<Items>): Items => ({ ...ZEROS, ...patch });
const total = (scores: Items): number => Object.values(scores).reduce((sum, n) => sum + n, 0);

const point = (assessmentId: string, capturedAt: string, itemScores: Items | null) => ({
  assessmentId,
  capturedAt,
  score: itemScores ? total(itemScores) : 20,
  scoreInterpretation: null,
  significantChange: false,
  ...(itemScores ? { itemScores } : {}),
});

let esasPoints: unknown[];
let ppsPoints: unknown[];
let calls: string[];

beforeEach(() => {
  esasPoints = [];
  ppsPoints = [];
  calls = [];
});

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input as RequestInfo, init);
  const path = new URL(request.url).pathname;
  calls.push(path);
  const scale = path.match(/\/scales\/([^/]+)\/series$/)?.[1];
  const stored = scale === "esas_r" ? esasPoints : scale === "pps" ? ppsPoints : null;
  if (stored === null) return new Response("{}", { status: 404 });
  // The route takes whole UTC dates and reads the end of `to` inclusive (assessments-route-service-db `seriesScale`).
  const query = new URL(request.url).searchParams;
  const from = `${query.get("from")}T00:00:00.000Z`;
  const to = `${query.get("to")}T23:59:59.999Z`;
  const points = stored.filter((candidate) => {
    const { capturedAt } = candidate as { capturedAt: string };
    return capturedAt >= from && capturedAt <= to;
  });
  return new Response(JSON.stringify({ scaleType: scale, patientId: PATIENT, from, to, points }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mountTrend(visitTime: string | null = VISIT_TIME) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ComposerScoreTrend patientId={PATIENT} serviceDate={SERVICE_DATE} visitTime={visitTime} />
    </ApiClientProvider>,
  );
}

const prompt = () =>
  screen.queryByRole("region", { name: /consider a fuller symptom assessment/i });

describe("EsasSymptomPrompt", () => {
  it("renders nothing without item scores, and nothing when no item reaches 4", () => {
    const { container, rerender } = render(
      <EsasSymptomPrompt itemScores={undefined} readOn="Aug 20" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<EsasSymptomPrompt itemScores={items({ pain: 3, wellbeing: 3 })} readOn="Aug 20" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists an item at exactly 4 and leaves out the one at 3, each as text with its score", () => {
    render(<EsasSymptomPrompt itemScores={items({ pain: 4, nausea: 3 })} readOn="Aug 20" />);
    const region = screen.getByRole("region", { name: "Consider a fuller symptom assessment" });
    // A <ul> is a list in jsdom without the attribute; the explicit role restores the semantics Safari drops.
    expect(within(region).getByRole("list")).toHaveAttribute("role", "list");
    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(
      "Pain: 4 of 10. Consider a fuller assessment of this symptom.",
    );
    expect(region).not.toHaveTextContent("Nausea");
  });

  it("lists several items in the published order with the published names", () => {
    render(
      <EsasSymptomPrompt
        itemScores={items({ wellbeing: 5, lackOfAppetite: 9, shortnessOfBreath: 4 })}
        readOn="Aug 20"
      />,
    );
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual([
      "Lack of appetite: 9 of 10. Consider a fuller assessment of this symptom.",
      "Shortness of breath: 4 of 10. Consider a fuller assessment of this symptom.",
      "Wellbeing: 5 of 10. Consider a fuller assessment of this symptom.",
    ]);
  });

  it("says which reading it is from, that it is a prompt and not a severity rating, and where it comes from", () => {
    render(<EsasSymptomPrompt itemScores={items({ pain: 6 })} readOn="Aug 20" />);
    const region = screen.getByRole("region", { name: "Consider a fuller symptom assessment" });
    expect(region).toHaveTextContent("From the ESAS-r reading of Aug 20.");
    expect(region).toHaveTextContent(
      "This is a prompt, not a finding or a severity rating. The cut-off varies by symptom and population. Scores run from 0 (best) to 10 (worst) for every item, wellbeing included.",
    );
    expect(region).toHaveTextContent("Research benchmark.");
    expect(region).toHaveTextContent(
      "Oldenmenger WH et al., J Pain Symptom Manage 2013;45:1083-93",
    );
    expect(region).toHaveTextContent("evidence is missing for 7 of the 9 items");
  });

  it("offers no action and uses none of the wording the research rules out", () => {
    render(
      <EsasSymptomPrompt itemScores={items({ pain: 10, anxiety: 7, nausea: 4 })} readOn="Aug 20" />,
    );
    const region = screen.getByRole("region", { name: "Consider a fuller symptom assessment" });
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
    expect(within(region).queryAllByRole("link")).toHaveLength(0);
    for (const word of [
      /notify/i,
      /physician/i,
      /doctor/i,
      /severe/i,
      /moderate/i,
      /\bmild\b/i,
      /urgent/i,
      /critical/i,
      /alert/i,
      /must/i,
    ]) {
      expect(region.textContent ?? "").not.toMatch(word);
    }
  });
});

describe("ComposerScoreTrend with the ESAS-r prompt", () => {
  it("shows the prompt for the items at 4 or more in the latest ESAS-r reading, beside its total", async () => {
    esasPoints = [point("e-1", "2026-08-20T10:00:00.000Z", items({ pain: 6, tiredness: 2 }))];
    mountTrend();
    expect(await screen.findByText("ESAS-r total")).toBeInTheDocument();
    const region = await screen.findByRole("region", {
      name: "Consider a fuller symptom assessment",
    });
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(region).toHaveTextContent("Pain: 6 of 10");
    expect(region).toHaveTextContent("From the ESAS-r reading of Aug 20.");
  });

  it("uses the latest reading up to the visit: a later reading and an earlier one are not mixed in", async () => {
    esasPoints = [
      point("e-1", "2026-08-10T10:00:00.000Z", items({ nausea: 8 })),
      point("e-2", "2026-08-20T10:00:00.000Z", items({ anxiety: 4 })),
      point("e-3", "2026-08-28T10:00:00.000Z", items({ depression: 9 })),
    ];
    mountTrend("2026-08-27T23:59:59.999Z");
    const region = await screen.findByRole("region", {
      name: "Consider a fuller symptom assessment",
    });
    expect(region).toHaveTextContent("Anxiety: 4 of 10");
    expect(region).not.toHaveTextContent("Nausea");
    expect(region).not.toHaveTextContent("Depression");
  });

  it("counts an evening reading stamped on the next UTC day, and still drops one taken after the visit", async () => {
    // A US org's service day 2026-08-27 ends at 2026-08-28T03:59:59.999Z (EDT): a reading at 8:30 pm local is 00:30Z on the 28th.
    esasPoints = [
      point("e-1", "2026-08-20T10:00:00.000Z", items({ anxiety: 4 })),
      point("e-2", "2026-08-28T00:30:00.000Z", items({ pain: 7 })),
      point("e-3", "2026-08-28T10:00:00.000Z", items({ depression: 9 })),
    ];
    mountTrend("2026-08-28T03:59:59.999Z");
    const region = await screen.findByRole("region", {
      name: "Consider a fuller symptom assessment",
    });
    expect(region).toHaveTextContent("Pain: 7 of 10");
    expect(region).not.toHaveTextContent("Anxiety");
    expect(region).not.toHaveTextContent("Depression");
  });

  it("shows no prompt when the latest reading carries no item scores (an older record or a redacted point)", async () => {
    esasPoints = [point("e-1", "2026-08-20T10:00:00.000Z", null)];
    mountTrend();
    expect(await screen.findByText("ESAS-r total")).toBeInTheDocument();
    expect(prompt()).not.toBeInTheDocument();
  });

  it("shows no prompt when every item is below 4", async () => {
    esasPoints = [point("e-1", "2026-08-20T10:00:00.000Z", items({ pain: 3, wellbeing: 3 }))];
    mountTrend();
    expect(await screen.findByText("ESAS-r total")).toBeInTheDocument();
    expect(prompt()).not.toBeInTheDocument();
  });

  it("shows no prompt for a PPS-only patient", async () => {
    ppsPoints = [
      { ...point("p-1", "2026-08-20T10:00:00.000Z", null), score: 50, scoreInterpretation: null },
    ];
    mountTrend();
    expect(await screen.findByText("PPS")).toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(prompt()).not.toBeInTheDocument();
  });
});
