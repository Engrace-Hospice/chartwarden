// The console's one session-expired decision (the actor-session GET answered 401) drops the held Idempotency-Keys, so the next sign-in on
// this page does not inherit the last session's unanswered writes. Any other answer for the context leaves them alone.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { ActorSessionProvider, useSessionState } from "./session";

function Status(): JSX.Element {
  return <p>{useSessionState().status}</p>;
}

function consoleWith(contextStatus: number) {
  const keys: (string | null)[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      keys.push(request.headers.get("Idempotency-Key"));
      if (request.url.endsWith("/api/v1/auth/context")) {
        return new Response("{}", { status: contextStatus });
      }
      if (keys.length === 1) throw new TypeError("Failed to fetch"); // the held write's reply is lost
      return new Response("{}", { status: 200 });
    },
  });
  const write = () =>
    client.POST("/api/v1/x" as never, { body: { a: 1 } } as never).catch(() => undefined);
  return { client, keys, write };
}

describe("ActorSessionProvider and the held Idempotency-Keys", () => {
  it("drops them when the session is confirmed gone (a 401)", async () => {
    const { client, keys, write } = consoleWith(401);
    await write(); // lost: its key is held

    render(
      <ApiClientProvider client={client}>
        <ActorSessionProvider>
          <Status />
        </ActorSessionProvider>
      </ApiClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("anonymous")).toBeTruthy());
    await write();

    expect(keys[2]).not.toBe(keys[0]); // keys[1] is the context read
  });

  it("keeps them when the context could not be read for another reason (an outage)", async () => {
    const { client, keys, write } = consoleWith(503);
    await write();

    render(
      <ApiClientProvider client={client}>
        <ActorSessionProvider>
          <Status />
        </ActorSessionProvider>
      </ApiClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("outage")).toBeTruthy());
    await write();

    expect(keys[2]).toBe(keys[0]);
  });
});
