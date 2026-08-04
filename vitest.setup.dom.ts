// WardenX — jsdom test setup (TASK-050C / TEST-004). Extends vitest's `expect` with DOM matchers
// and unmounts every rendered tree after each test so component/router state never leaks between
// cases. Runs for every test file (node-env tests never call `render()`, so `cleanup()` is a no-op
// there) — one setup file is simpler than splitting into per-environment projects.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
});
