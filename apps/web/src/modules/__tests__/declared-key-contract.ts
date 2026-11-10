// The contract of a module-level API function whose route DECLARES the Idempotency-Key header (so the typed client makes the call name it):
// the key comes from the shared attempt keys, one per write intent. A retry after a request that got no answer, a gateway page or the
// in-flight 409 replays under the same key; any other answer, a changed intent and the end of the session all renew it.
import type { ApiClient } from "@chartwarden/ui";
import { sharedAttemptKeys } from "@chartwarden/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = "no answer" | { status: number; error?: unknown };

const GATEWAY: Reply = { status: 502, error: "<html>Bad Gateway</html>" };
const IN_FLIGHT: Reply = {
  status: 409,
  error: { error: { code: "IDEMPOTENCY_IN_FLIGHT", message: "still being processed" } },
};
const VALIDATION: Reply = {
  status: 422,
  error: { error: { code: "VALIDATION_ERROR", message: "invalid" } },
};
const OK: Reply = { status: 200 };

/** A client whose every write answers from `replies` in turn (then 200) and records the Idempotency-Key it was sent. */
function recordingClient(replies: Reply[]) {
  const sent: string[] = [];
  const write = vi.fn(
    async (_path: string, init: { params: { header: Record<string, string> } }) => {
      sent.push(init.params.header["Idempotency-Key"] ?? "");
      const reply = replies.shift() ?? OK;
      if (reply === "no answer") throw new TypeError("Failed to fetch");
      const succeeded = reply.status < 300;
      return {
        data: succeeded ? { id: "x" } : undefined,
        error: succeeded ? undefined : reply.error,
        response: new Response(null, { status: reply.status }),
      };
    },
  );
  return { client: { PATCH: write, POST: write, DELETE: write } as unknown as ApiClient, sent };
}

/** One write site: `changed` asks for the same call about a different intent (another version, another body). */
export type WriteSite = readonly [
  name: string,
  act: (client: ApiClient, changed?: boolean) => Promise<unknown>,
];

export function describeDeclaredKeyContract(title: string, sites: readonly WriteSite[]): void {
  describe(title, () => {
    beforeEach(() => sharedAttemptKeys.clear());

    describe.each(sites)("%s", (_name, act) => {
      it("retries a request that got no answer under the same key", async () => {
        const { client, sent } = recordingClient(["no answer"]);

        await expect(act(client)).rejects.toThrow("Failed to fetch");
        await act(client);

        expect(sent).toHaveLength(2);
        expect(sent[0]).toBeTruthy();
        expect(sent[1]).toBe(sent[0]);
      });

      it.each([
        ["a gateway page", GATEWAY],
        ["an in-flight duplicate", IN_FLIGHT],
      ])("retries after %s under the same key", async (_label, reply) => {
        const { client, sent } = recordingClient([reply]);

        await act(client);
        await act(client);

        expect(sent[0]).toBeTruthy();
        expect(sent[1]).toBe(sent[0]);
      });

      it.each([
        ["a success", OK],
        ["a refusal from the API", VALIDATION],
      ])("sends a new key after %s", async (_label, reply) => {
        const { client, sent } = recordingClient([reply]);

        await act(client);
        await act(client);

        expect(sent[1]).toBeTruthy();
        expect(sent[1]).not.toBe(sent[0]);
      });

      it("sends a different key for a changed intent", async () => {
        const { client, sent } = recordingClient(["no answer"]);

        await expect(act(client)).rejects.toThrow();
        await act(client, true);

        expect(sent[1]).not.toBe(sent[0]);
      });

      it("sends a new key once the session's held keys are cleared", async () => {
        const { client, sent } = recordingClient(["no answer"]);

        await expect(act(client)).rejects.toThrow();
        sharedAttemptKeys.clear();
        await act(client);

        expect(sent[1]).not.toBe(sent[0]);
      });
    });
  });
}
