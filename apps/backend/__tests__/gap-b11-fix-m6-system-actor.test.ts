// GAP-b11-fix — M6 org-explicit seam envelopes must record the NULL system actor, never an inherited
// request actor. A blank `userId` alone inherits the ambient request user (GAP-111); `systemActor: true` pins NULL.
import { runWithRequestContext } from "@chartwarden/tenancy";
import { describe, expect, it } from "vitest";
import {
  admissionIsActiveForOrg,
  admissionSchedulingContextForOrg,
} from "../src/modules/06-admission/seams/drizzle-store";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQUEST_USER = "22222222-2222-4222-8222-222222222222";

/** A db whose tx records the bound value of every `set_config('app.user_id', …)` and stops at the first select. */
function recordingDb() {
  const actors: unknown[] = [];
  const tx = {
    execute: async (query: { queryChunks: unknown[] }) => {
      const text = JSON.stringify(query.queryChunks);
      if (!text.includes("app.user_id")) return;
      // The bound actor is the lone non-StringChunk param chunk; a Param wraps it as `.value`.
      const param = query.queryChunks.find((c) => !Array.isArray((c as { value?: unknown }).value));
      actors.push((param as { value?: unknown } | undefined)?.value ?? param);
    },
    select: () => {
      throw new Error("stop");
    },
  };
  const db = { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { db: db as never, actors };
}

describe("M6 seam envelopes record the NULL system actor", () => {
  it.each([
    ["admissionIsActiveForOrg", (db: never) => admissionIsActiveForOrg(db, ORG, "a")],
    [
      "admissionSchedulingContextForOrg",
      (db: never) => admissionSchedulingContextForOrg(db, ORG, "a"),
    ],
  ])("%s ignores the ambient request actor", async (_name, call) => {
    const { db, actors } = recordingDb();
    await runWithRequestContext({ organizationId: ORG, userId: REQUEST_USER }, async () => {
      await call(db).catch(() => undefined);
    });
    expect(actors).toEqual([""]);
  });
});
