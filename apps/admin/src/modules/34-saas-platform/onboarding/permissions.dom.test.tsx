// @vitest-environment jsdom
// useCan fails closed: naming no key answers false even for an operator holding every onboarding key (a gate with no key is a bug).
import { cleanup, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ONBOARDING_KEYS, useCan } from "./permissions";
import { renderAt, stubClient } from "./test-support";

function Probe({ keys }: { keys: readonly string[] }): JSX.Element {
  return <output data-testid="can">{String(useCan(...keys))}</output>;
}
const probe = (keys: readonly string[]): string | null => {
  renderAt("/x", [{ path: "/x", element: <Probe keys={keys} /> }], stubClient({}));
  return screen.getByTestId("can").textContent;
};

describe("useCan", () => {
  afterEach(cleanup);

  it("is false with no keys, even for an operator holding every onboarding key", () => {
    expect(probe([])).toBe("false");
  });

  it("is true for a key the operator holds", () => {
    expect(probe([ONBOARDING_KEYS.baaRegisterWrite])).toBe("true");
  });
});
