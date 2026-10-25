// The claim page's submission history: submissions and acknowledgments read on their own, so an unavailable read is said
// so and never looks like "no history", and an empty one says what is missing.
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaimHistory } from "../claim-history";

afterEach(cleanup);

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});
const fail = () => ({
  data: undefined,
  error: { error: { code: "X" } },
  response: new Response(null, { status: 503 }),
});

function mount(get: (path: string) => unknown) {
  render(
    <ApiClientProvider client={{ GET: vi.fn(async (p: string) => get(p)) } as unknown as ApiClient}>
      <ClaimHistory claimId="c1" />
    </ApiClientProvider>,
  );
}

describe("ClaimHistory", () => {
  it("lists dispatch attempts and acknowledgments", async () => {
    mount((p) =>
      p.endsWith("/submissions")
        ? ok([
            {
              submissionId: "s1",
              kind: "initial",
              claimControlNumber: "CCN-1",
              attemptIndex: 1,
              outcome: "accepted",
              outcomeReason: null,
              generatedFileUri: null,
              submittedAt: "2026-10-01T00:00:00Z",
              createdAt: "2026-10-01T00:00:00Z",
            },
          ])
        : ok([
            {
              acknowledgmentId: "a1",
              submissionId: "s1",
              kind: "999",
              macJurisdiction: "JK",
              ackReceivedAt: "2026-10-02T00:00:00Z",
              parsedAt: "2026-10-02T00:00:00Z",
              outcomeStatus: "accepted",
              parsedPayload: {},
            },
          ]),
    );
    expect(await screen.findByText("999 · Functional ack")).toBeTruthy();
    expect(screen.getByText("Initial")).toBeTruthy();
  });

  it("says a failed read is unavailable, not empty, and still shows the other section", async () => {
    mount((p) => (p.endsWith("/submissions") ? fail() : ok([])));
    expect(await screen.findByText(/Submissions could not be read/)).toBeTruthy();
    expect(screen.getByText(/No 999 \/ 277CA \/ 835 acknowledgments/)).toBeTruthy();
    expect(screen.queryByText(/No dispatch attempts/)).toBeNull();
  });
});
