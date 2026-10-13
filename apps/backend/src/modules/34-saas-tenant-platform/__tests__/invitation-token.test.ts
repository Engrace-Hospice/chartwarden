// The first-admin invitation secret: the emailed URL carries the RAW token, the row stores only its sha256 hex, and the
// public accept route hashes the URL's token the same way — so the three must agree or the link reads "invalid".
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintInvitationToken } from "../invitation-token";

describe("mintInvitationToken", () => {
  it("stores the sha256 hex of the raw token that the URL carries", () => {
    const { rawToken, tokenHash, invitationUrl } = mintInvitationToken(
      "https://app.test/tenant-invite",
    );

    expect(tokenHash).toBe(createHash("sha256").update(rawToken).digest("hex"));
    expect(invitationUrl).toBe(`https://app.test/tenant-invite/${rawToken}`);
  });

  it("does not double the slash when the base URL ends with one", () => {
    const { rawToken, invitationUrl } = mintInvitationToken("https://app.test/tenant-invite/");

    expect(invitationUrl).toBe(`https://app.test/tenant-invite/${rawToken}`);
  });

  it("mints a fresh unguessable token every time", () => {
    const a = mintInvitationToken("https://app.test/x");
    const b = mintInvitationToken("https://app.test/x");

    expect(a.rawToken).not.toBe(b.rawToken);
    expect(a.rawToken.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
  });
});
