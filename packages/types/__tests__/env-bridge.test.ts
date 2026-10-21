import { describe, expect, it } from "vitest";
import { bridgeLegacyEnv } from "../src/env-bridge";

describe("bridgeLegacyEnv", () => {
  it("copies a legacy WARDENX_ variable to its CHARTWARDEN_ name", () => {
    const env: Record<string, string | undefined> = { WARDENX_APP_PASSWORD: "p" };

    const used = bridgeLegacyEnv(env);

    expect(env.CHARTWARDEN_APP_PASSWORD).toBe("p");
    expect(used).toEqual(["WARDENX_APP_PASSWORD"]);
  });

  it("never overwrites a CHARTWARDEN_ value that is already set", () => {
    const env: Record<string, string | undefined> = {
      WARDENX_IMAGE: "old",
      CHARTWARDEN_IMAGE: "new",
    };

    const used = bridgeLegacyEnv(env);

    expect(env.CHARTWARDEN_IMAGE).toBe("new");
    expect(used).toEqual([]);
  });

  it("keeps an empty CHARTWARDEN_ value rather than falling back to the legacy one", () => {
    const env: Record<string, string | undefined> = {
      WARDENX_DEPLOY_ALLOW_UNVERIFIED: "1",
      CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED: "",
    };

    bridgeLegacyEnv(env);

    expect(env.CHARTWARDEN_DEPLOY_ALLOW_UNVERIFIED).toBe("");
  });

  it("bridges an empty legacy value and ignores unrelated and similar-looking names", () => {
    const env: Record<string, string | undefined> = {
      WARDENX_EMPTY: "",
      WARDENXISH: "x",
      NOT_WARDENX_X: "y",
      PATH: "/bin",
    };

    const used = bridgeLegacyEnv(env);

    expect(env.CHARTWARDEN_EMPTY).toBe("");
    expect(used).toEqual(["WARDENX_EMPTY"]);
    expect(Object.keys(env).sort()).toEqual(
      ["CHARTWARDEN_EMPTY", "NOT_WARDENX_X", "PATH", "WARDENXISH", "WARDENX_EMPTY"].sort(),
    );
  });
});
