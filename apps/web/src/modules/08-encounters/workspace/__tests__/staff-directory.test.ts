// Workflow 09, WP1 (R18) — the visit context header reads the staff list once per client and user, not on every mount.
import type { ApiClient } from "@chartwarden/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { staffDirectory } from "../staff-directory";

const clientReturning = (...answers: Array<unknown | Error>) => {
  const GET = vi.fn(async () => {
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { client: { GET } as unknown as ApiClient, GET };
};

const list = {
  data: [{ membershipId: "mem-1", displayName: "Nora Nurse" }, { membershipId: "mem-2" }],
};

afterEach(() => vi.useRealTimers());

describe("staffDirectory", () => {
  it("maps membership ids to names and leaves out a member without one", async () => {
    const { client } = clientReturning(list);
    const directory = await staffDirectory(client, "org:user");
    expect(directory.get("mem-1")).toBe("Nora Nurse");
    expect(directory.has("mem-2")).toBe(false);
  });

  it("reads the list once for several headers, even when they ask at the same time", async () => {
    const { client, GET } = clientReturning(list);
    await Promise.all([staffDirectory(client, "org:user"), staffDirectory(client, "org:user")]);
    await staffDirectory(client, "org:user");
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("does not hand one user's list to another on the same client", async () => {
    const { client, GET } = clientReturning(list);
    await staffDirectory(client, "org-1:user-1");
    await staffDirectory(client, "org-2:user-2");
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("reads again after the list has expired", async () => {
    vi.useFakeTimers();
    const { client, GET } = clientReturning(list);
    await staffDirectory(client, "org:user");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await staffDirectory(client, "org:user");
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a network failure", new TypeError("offline")],
    ["a refusal", { error: { code: "FORBIDDEN" } }],
    ["an answer that is not a list", { data: { staff: [] } }],
  ])("shows no names and tries again on the next mount after %s", async (_name, failure) => {
    const { client, GET } = clientReturning(failure, list);
    expect((await staffDirectory(client, "org:user")).size).toBe(0);
    const second = await staffDirectory(client, "org:user");
    expect(second.get("mem-1")).toBe("Nora Nurse");
    expect(GET).toHaveBeenCalledTimes(2);
  });
});
