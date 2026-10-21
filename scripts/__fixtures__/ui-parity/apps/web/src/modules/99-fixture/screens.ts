// Planted violation (TASK-050D): a screens.ts that exists but the fixture's main.tsx never
// imports or registers — the "UNREGISTERED SCREENS" hard-fail (the M30/M39 import-without-register
// incident this check was built to catch).
import type { ScreenRegistryModule } from "@chartwarden/types";

export const fixtureScreens: ScreenRegistryModule = {
  moduleId: 99,
  slug: "99-fixture",
  screens: [{ id: "fixture.one", path: "/fixture-one", title: "Fixture", screen: () => null }],
};
