import { fireEvent, render, screen, waitFor } from "@testing-library/react";
// apps/web/src/modules/05-patient — GAP-080: a patient name / MRN must never reach the browser URL.
//
// The global search needle is PHI. Carried as `?q=…` it lands in the address bar, the history
// entry, the omnibox autocomplete corpus and the profile's on-disk session-restore state, where it
// outlives the session on a shared device — the exact exposure this screen's own code comment
// already refuses for its "recent searches" list, reached through a different door.
//
// It lives beside the M5 screen rather than in the shell because it imports both, and the M5→M1
// direction is the declared one (M5 dependsOn 1; the shell may never import a feature module).
//
// This runs the REAL shell against the REAL M5 screen (a 404-stubbed API, like the smoke test) and
// asserts on `window.location` after each interaction, because that is the artifact that leaks:
// asserting that some function was called with the right argument would still pass if a navigation
// somewhere put the term back in the URL.
import { createApiClient } from "@wardenx/ui";
import { __resetSearchTermForTest } from "@wardenx/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../shell/app";
import { createScreenRegistry } from "../../shell/screen-registry";
import type { Session } from "../../shell/session";
import { systemScreens } from "../../shell/system-pages";
import { patientScreens } from "./screens";

const SESSION: Session = {
  userId: "phi-user",
  organizationId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  displayName: "URL PHI Test",
  organizationName: "Test Org",
  roles: ["administrator"],
  isAdmin: true,
  permissions: [],
};

// Every URL the app WRITES to session history, in order. Asserting only on the final
// `window.location` is too weak: a term pushed and then scrubbed a tick later has already been
// handed to the address bar, the omnibox autocomplete corpus and the back/forward entry — the leak
// is the write, not the residue. So the history API itself is recorded.
let historyWrites: string[] = [];
const realPush = window.history.pushState.bind(window.history);
const realReplace = window.history.replaceState.bind(window.history);

/** The needle a leak would expose. Distinctive enough to grep the whole URL for. */
const NEEDLE = "Okafor-MRN-88421";

async function stubFetch(): Promise<Response> {
  return new Response(JSON.stringify({ error: { code: "STUB", message: "no backend" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function mount(path: string) {
  // Deliberately the REAL pushState, not the recording spy: arriving AT a URL is the inbound event
  // under test, never something the app wrote. Only writes made after this point count.
  realPush({}, "", path);
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register(patientScreens);
  return render(
    <AppShell
      registry={registry}
      client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      session={SESSION}
    />,
  );
}

/** Everything a URL can carry: path, query and fragment. None of it may contain the needle. */
const fullUrl = (): string =>
  `${window.location.pathname}${window.location.search}${window.location.hash}`;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(stubFetch));
  __resetSearchTermForTest();
  historyWrites = [];
  vi.spyOn(window.history, "pushState").mockImplementation((d, u, url) => {
    historyWrites.push(String(url ?? ""));
    realPush(d, u, url as string);
  });
  vi.spyOn(window.history, "replaceState").mockImplementation((d, u, url) => {
    historyWrites.push(String(url ?? ""));
    realReplace(d, u, url as string);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetSearchTermForTest();
});

/** No URL the app wrote to history may carry any part of the needle. */
function expectNoNeedleEverWrittenToHistory(): void {
  for (const url of historyWrites) {
    expect(decodeURIComponent(url), `history write leaked the needle: ${url}`).not.toContain(
      "Okafor",
    );
  }
}

describe("GAP-080 — the search needle never reaches the URL", () => {
  it("the shell top-nav search navigates to /search with no query string", async () => {
    mount("/");
    const box = screen.getByLabelText("Global search");
    fireEvent.change(box, { target: { value: NEEDLE } });
    fireEvent.submit(box.closest("form") as HTMLFormElement);

    await waitFor(() => expect(window.location.pathname).toBe("/search"));
    expect(window.location.search).toBe("");
    expect(fullUrl()).not.toContain("Okafor");
    expectNoNeedleEverWrittenToHistory();
  });

  it("hands the needle to the results screen even though the URL does not carry it", async () => {
    mount("/");
    const box = screen.getByLabelText("Global search");
    fireEvent.change(box, { target: { value: NEEDLE } });
    fireEvent.submit(box.closest("form") as HTMLFormElement);

    // The API is stubbed to 404, so both facets come back empty and the screen renders its
    // "no results for <term>" state — which proves the term ARRIVED, not merely that it vanished.
    await waitFor(() => expect(screen.getByText(new RegExp(NEEDLE))).toBeTruthy());
    expect(window.location.search).toBe("");
    expectNoNeedleEverWrittenToHistory();
  });

  it("searching again from the results screen's own form does not write a query string", async () => {
    mount("/search");
    const form = screen.getByLabelText("Search patients and staff");
    fireEvent.change(form, { target: { value: NEEDLE } });
    fireEvent.submit(form.closest("form") as HTMLFormElement);

    await waitFor(() => expect(screen.getByText(new RegExp(NEEDLE))).toBeTruthy());
    expect(fullUrl()).toBe("/search");
    expectNoNeedleEverWrittenToHistory();
  });

  it("honors a legacy ?q= deep link once, then scrubs it from the history entry", async () => {
    // Nothing in the app writes one any more, so this can only arrive from outside — a bookmark or
    // a pasted link made before the fix. Dropping it silently would break the link; leaving it
    // would re-create the leak on every such visit.
    mount(`/search?q=${encodeURIComponent(NEEDLE)}`);

    await waitFor(() => expect(screen.getByText(new RegExp(NEEDLE))).toBeTruthy());
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(fullUrl()).toBe("/search");
    // The needle arrived from OUTSIDE (mount uses the real pushState, bypassing the recorder), so
    // what this asserts is that the app never wrote it BACK — only the scrubbed "/search".
    expectNoNeedleEverWrittenToHistory();
  });
});
