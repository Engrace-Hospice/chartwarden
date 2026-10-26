import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// #821: the key survives only a thrown request; any HTTP answer or a different request mints a new one.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { DdeFileAction, claimDdeOptions } from "../dde-file-action";
import { expectNewKey, expectSameKey } from "./idempotency-test-utils";

const ok = { data: {}, error: undefined, response: new Response(null, { status: 201 }) };
const http503 = {
  data: undefined,
  error: { error: { message: "down" } },
  response: new Response(null, { status: 503 }),
};

function setup(post: ReturnType<typeof vi.fn>) {
  const client = { POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <DdeFileAction subjectId="s1" options={claimDdeOptions("paid")} />
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

const click = async (name: string) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await screen.findByRole(/* settled: either the alert or the queued region */ "button", { name });
  await new Promise((r) => setTimeout(r, 0));
};

describe("DdeFileAction Idempotency-Key (#821)", () => {
  it("reuses the key when the first request threw", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValueOnce(ok);
    setup(POST);
    await click("Adjust claim");
    await click("Adjust claim");
    expectSameKey(POST, 0, 1);
  });

  it("mints a new key after an HTTP error answer", async () => {
    const POST = vi.fn().mockResolvedValueOnce(http503).mockResolvedValueOnce(ok);
    setup(POST);
    await click("Adjust claim");
    await click("Adjust claim");
    expectNewKey(POST, 0, 1);
  });

  it("mints a new key when a different item is filed after a thrown request", async () => {
    const POST = vi.fn().mockRejectedValueOnce(new TypeError("net")).mockResolvedValueOnce(ok);
    setup(POST);
    await click("Adjust claim");
    await click("Cancel claim");
    expectNewKey(POST, 0, 1);
  });
});
