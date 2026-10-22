// Literal oracle: the Better Auth plugin ids carry the ChartWarden name (in-process registry keys, never stored).
import { describe, expect, it } from "vitest";
import { credentialAdminPlugin } from "../src/identity/credential-admin";
import { linkSessionPlugin } from "../src/identity/link-session";

describe("Better Auth plugin ids", () => {
  it("are chartwarden-*", () => {
    expect(credentialAdminPlugin().id).toBe("chartwarden-credential-admin");
    expect(linkSessionPlugin().id).toBe("chartwarden-link-session");
  });
});
