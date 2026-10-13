// WardenX — jsdom test setup (TASK-050C / TEST-004). Extends vitest's `expect` with DOM matchers
// and unmounts every rendered tree after each test so component/router state never leaks between
// cases. Runs for every test file (node-env tests never call `render()`, so `cleanup()` is a no-op
// there) — one setup file is simpler than splitting into per-environment projects.
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement Element.scrollTo (every real browser does) — apps/web/src/shell/layout.tsx
// calls `mainRef.current?.scrollTo(0, 0)` on route change (the live-browser-audit scroll-reset fix),
// which throws "scrollTo is not a function" under jsdom with no polyfill. A no-op stub is a faithful
// stand-in here: jsdom has no real layout/scroll position to reset in the first place.
if (typeof Element !== "undefined" && typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}

// jsdom does not implement ResizeObserver. The app shell observes its own header to publish a CSS
// variable; in tests there is no real layout to observe, so a no-op observer preserves the browser
// contract shape without inventing measurements.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

// Under jsdom, `AbortController`/`AbortSignal` come from jsdom while `Request`/`fetch` come from
// Node (undici) — two different implementations of the same interface. undici's Request constructor
// brand-checks `init.signal` and throws
//     TypeError: RequestInit: Expected signal ("AbortSignal {}") to be an instance of AbortSignal
// for a perfectly valid jsdom signal. Nothing in the app hits this, but react-router's data router
// builds a `new Request(url, { signal })` on EVERY client-side navigation
// (`createClientSideRequest`), so any dom test that navigates rather than just mounting a route
// crashes — which is why the pre-existing smoke tests only ever pushState + render.
//
// The narrowest possible reconciliation: keep undici's real Request (every method, every behavior)
// and drop only the cross-realm signal. Test navigations are not aborted, so nothing observable is
// lost; a component that genuinely depends on request abortion should assert on its own
// AbortController, not on this.
const UndiciRequest = globalThis.Request;
if (typeof UndiciRequest === "function") {
  globalThis.Request = class extends UndiciRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init ? { ...init, signal: undefined } : init);
    }
  } as typeof Request;
}

// Node's experimental Web Storage defines a global `localStorage` that vitest's jsdom environment will not overwrite,
// and without a `--localstorage-file` it is a stub with no methods (`window.localStorage.clear is not a function`).
// An in-memory Storage is a faithful stand-in: jsdom's own localStorage is also per-test-process memory.
function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(String(key)) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(String(key)),
    setItem: (key, value) => void data.set(String(key), String(value)),
  };
}
if (typeof window !== "undefined" && typeof window.localStorage?.clear !== "function") {
  const storage = createMemoryStorage();
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

// Testing Library's default 1000 ms findBy*/waitFor timeout is shorter than a debounced lookup (the @-mention
// candidates wait 250 ms) plus a render on a loaded machine: the M36 mention tests failed only under CPU contention,
// never in isolation. Passing waits return immediately, so a longer ceiling costs nothing.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});
