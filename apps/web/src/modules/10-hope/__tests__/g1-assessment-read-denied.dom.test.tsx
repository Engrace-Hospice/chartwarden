// @vitest-environment jsdom
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, type vi } from "vitest";
import { clientFor, renderWorkspace, useStubbedLocalStorage } from "./workspace-test-kit";

// Group g1: hope.scope answers an assessment outside the caller's caseload with 404 (deny-as-not-found), a plain refusal with 403.
// Try again changes neither, so that read is final; any other failure stays retryable.

afterEach(cleanup);

const RECORD = "/api/v1/hope/assessments/{id}";
const refused = (status: number, body: unknown) => ({
  data: undefined,
  error: body,
  response: new Response(null, { status }),
});

function clientRecordAnswers(answer: () => unknown): {
  client: ApiClient;
  recordReads: () => number;
} {
  const client = clientFor();
  const get = client.GET as unknown as ReturnType<typeof vi.fn>;
  const standard = get.getMockImplementation() as (p: string, i?: unknown) => Promise<unknown>;
  let reads = 0;
  get.mockImplementation(async (path: string, init?: unknown) => {
    if (path !== RECORD) return standard(path, init);
    reads += 1;
    return answer();
  });
  return { client, recordReads: () => reads };
}

describe("the assessment record read", () => {
  useStubbedLocalStorage();

  it.each([403, 404])("is final, with no Try again that cannot help, for a %i", async (status) => {
    const { client, recordReads } = clientRecordAnswers(() =>
      refused(status, { error: { code: "NOT_FOUND", message: "Not found" } }),
    );
    renderWorkspace(client);
    expect(
      await screen.findByText(/HOPE assessment was not found, or is not available to you/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText("Could not load this HOPE assessment.")).toBeNull();
    expect(recordReads()).toBe(1);
  });

  it.each([
    ["an empty-bodied 502", () => refused(502, undefined)],
    ["a 500 with an error body", () => refused(500, { error: { code: "INTERNAL", message: "x" } })],
  ])("is still retryable for %s, and the retry reads again", async (_name, answer) => {
    const { client, recordReads } = clientRecordAnswers(answer);
    renderWorkspace(client);
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText("Could not load this HOPE assessment.")).toBeTruthy();
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Try again" });
    expect(recordReads()).toBe(2);
  });
});
