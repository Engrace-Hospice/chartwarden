// #589 — createPasswordVerifier proves a password for a known user WITHOUT minting a session. The branch that matters
// besides "right/wrong password" is an account with no credential password (a link-session or social-only user): it must
// answer false AND still spend a hash, so response time does not reveal whether a password account exists.
import { describe, expect, it, vi } from "vitest";
import { createPasswordVerifier } from "../src/identity/password-verifier";

function fakeAuth(accounts: Array<{ providerId: string; password?: string | null }>) {
  const verify = vi.fn(async ({ hash, password }: { hash: string; password: string }) => hash === `h(${password})`);
  const hash = vi.fn(async (password: string) => `h(${password})`);
  const findAccounts = vi.fn(async () => accounts);
  const auth = {
    $context: Promise.resolve({ password: { verify, hash }, internalAdapter: { findAccounts } }),
  };
  return { auth, verify, hash, findAccounts };
}

describe("createPasswordVerifier", () => {
  it("accepts the right password and rejects a wrong one, via the credential account's hash", async () => {
    const { auth, findAccounts } = fakeAuth([{ providerId: "credential", password: "h(right)" }]);
    const verifier = createPasswordVerifier(auth);

    expect(await verifier.verify({ userId: "u1", password: "right" })).toBe(true);
    expect(await verifier.verify({ userId: "u1", password: "wrong" })).toBe(false);
    expect(findAccounts).toHaveBeenCalledWith("u1");
  });

  it("ignores non-credential accounts and spends a dummy hash when there is no password to check", async () => {
    const { auth, verify, hash } = fakeAuth([{ providerId: "google", password: "h(right)" }]);
    const verifier = createPasswordVerifier(auth);

    expect(await verifier.verify({ userId: "u1", password: "right" })).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it("treats a credential account with an empty password the same way", async () => {
    const { auth, verify, hash } = fakeAuth([{ providerId: "credential", password: null }]);

    expect(await createPasswordVerifier(auth).verify({ userId: "u1", password: "anything" })).toBe(false);
    expect(verify).not.toHaveBeenCalled();
    expect(hash).toHaveBeenCalledTimes(1);
  });
});
