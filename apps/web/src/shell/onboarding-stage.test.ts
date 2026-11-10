// What the shell knows about an organization that is still being onboarded: one declaration of the home path and of the screens that
// work while confined, read by the shell's watcher, the background pollers and the wizard's gate.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ONBOARDING_HOME,
  ONBOARDING_SCREENS,
  isOnboardingScreen,
  isOnboardingSession,
} from "./onboarding-stage";

describe("isOnboardingScreen", () => {
  it.each([
    "/admin/onboarding",
    "/admin/onboarding/:stepKey",
    "/admin/account",
    "/admin/setup",
    "/security/passkeys",
  ])("lets %s through", (path) => {
    expect(isOnboardingScreen(path)).toBe(true);
  });

  it("is a prefix of whole segments, not of letters", () => {
    expect(isOnboardingScreen("/admin/onboarding-extra")).toBe(false);
    expect(isOnboardingScreen("/admin/accounting")).toBe(false);
    expect(isOnboardingScreen("/admin/support-grants")).toBe(false);
    expect(isOnboardingScreen("/")).toBe(false);
  });

  it("includes the passkey screen the step-up ceremony sends a person with no enrolled factor to", () => {
    expect(ONBOARDING_SCREENS).toContain("/security/passkeys");
  });
});

describe("isOnboardingSession", () => {
  it("is true only for a session that says onboarding: absent or live is not", () => {
    expect(isOnboardingSession({ organizationStage: "onboarding" })).toBe(true);
    expect(isOnboardingSession({ organizationStage: "live" })).toBe(false);
    expect(isOnboardingSession({})).toBe(false);
    expect(isOnboardingSession(null)).toBe(false);
  });
});

describe("one declaration of the wizard's home", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(join(dir, e.name))
        : e.name.endsWith(".ts") || e.name.endsWith(".tsx")
          ? [join(dir, e.name)]
          : [],
    );

  it("is declared in onboarding-stage.ts only (the shell and the gate import it)", () => {
    const here = join(__dirname, "..");
    const declaring = files(here).filter(
      (f) => !/\.test\.tsx?$/.test(f) && /const ONBOARDING_HOME\b/.test(readFileSync(f, "utf8")),
    );
    expect(declaring.map((f) => f.slice(here.length + 1))).toEqual(["shell/onboarding-stage.ts"]);
    expect(ONBOARDING_HOME).toBe("/admin/onboarding");
  });
});
