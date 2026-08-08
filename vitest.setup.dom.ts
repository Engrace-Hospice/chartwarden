// WardenX — jsdom test setup (TASK-050C / TEST-004). Extends vitest's `expect` with DOM matchers
// and unmounts every rendered tree after each test so component/router state never leaks between
// cases. Runs for every test file (node-env tests never call `render()`, so `cleanup()` is a no-op
// there) — one setup file is simpler than splitting into per-environment projects.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement Element.scrollTo (every real browser does) — apps/web/src/shell/layout.tsx
// calls `mainRef.current?.scrollTo(0, 0)` on route change (the live-browser-audit scroll-reset fix),
// which throws "scrollTo is not a function" under jsdom with no polyfill. A no-op stub is a faithful
// stand-in here: jsdom has no real layout/scroll position to reset in the first place.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}

afterEach(() => {
  cleanup();
});
