/**
 * #94 — the request-body contract gate (`scripts/check-request-body-contract.ts`).
 *
 * The gate answers one question: does a route's PUBLISHED request body agree with the body its handler
 * actually reads? Both directions of disagreement are silent in different ways, and the tests below pin
 * the two that actually bit this repo — a published body nobody reads (a payload accepted and dropped,
 * #114) and a read body nobody publishes (`client:gen` types it `never`).
 */
import { describe, expect, it } from "vitest";
import { blankNonCode, checkRoutes, extractRouteCall } from "../check-request-body-contract";

type Route = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  module: string;
  file: string;
};
const route = (method: Route["method"], path: string): Route => ({
  method,
  path,
  module: "test",
  file: "routes.ts",
});
const run = (src: string, routes: Route[], withBody: string[]) =>
  checkRoutes(
    routes,
    () => src,
    (key) => withBody.includes(key),
  );

describe("blankNonCode", () => {
  it("blanks line comments, block comments and string contents, preserving offsets", () => {
    const src = `const a = "x(y"; // don't (
/* also ) here */ const b = 1;`;
    const out = blankNonCode(src);
    expect(out).toHaveLength(src.length);
    expect(out).not.toContain("don't");
    expect(out).not.toContain("x(y");
    // Code survives.
    expect(out).toContain("const a = ");
    expect(out).toContain("const b = 1;");
  });

  it("is why extraction works at all: an apostrophe in prose must not open a string", () => {
    // The bug this function exists for. Scanning for a matching `)` while treating `'` as a delimiter
    // breaks on the first apostrophe in a comment, after which every paren reads as "inside a string"
    // and the scan runs to EOF. That silently cost 16 handlers, the Stripe webhook among them.
    const src = `app.post("/a", async (request) => {
  // Stripe's TOS wants a fast 200 (even on replay)
  return request.body;
});`;
    const call = extractRouteCall(src, "post", "/a");
    expect(call).not.toBeNull();
    expect(call).toContain("request.body");
    // Balanced: the extracted call ends at the route's own close paren, not at EOF.
    expect((call as string).endsWith(")")).toBe(true);
  });

  it("does not run past the route's closing paren into a following comment", () => {
    const src = `app.post("/a", async () => ({ ok: true }));

// vendor webhooks read request.body — this text belongs to the NEXT route, not to /a
app.post("/b", async (request) => request.body);`;
    const call = extractRouteCall(src, "post", "/a") as string;
    expect(call).not.toContain("request.body");
  });
});

describe("checkRoutes", () => {
  const PUBLISHED_UNREAD = `app.post("/api/v1/x", { preHandler: [G] }, async (request) => {
  const { id } = parse(Params, request.params);
  return service.act(id);
});`;
  const READS = `app.post("/api/v1/x", async (request) => {
  const body = parse(Body, request.body);
  return service.act(body);
});`;

  it("flags a published body the handler never reads — the payload is accepted and dropped", () => {
    const { violations } = run(PUBLISHED_UNREAD, [route("post", "/api/v1/x")], ["POST /api/v1/x"]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("publishes-unread");
  });

  it("flags a read body the contract publishes none for — client:gen types it `never`", () => {
    const { violations } = run(READS, [route("post", "/api/v1/x")], []);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("reads-unpublished");
  });

  it("passes when both agree — body published and read", () => {
    expect(run(READS, [route("post", "/api/v1/x")], ["POST /api/v1/x"]).violations).toEqual([]);
  });

  it("passes when both agree — a payload-free action publishing nothing", () => {
    // The case `mutatingNoBody` counts as a deficit and this gate correctly does not: an action POST
    // that takes no payload is right to publish none. Measuring presence rather than AGREEMENT is what
    // made publishing `{}` the cheapest way to satisfy that metric.
    expect(run(PUBLISHED_UNREAD, [route("post", "/api/v1/x")], []).violations).toEqual([]);
  });

  it("does not ask the question of GET or DELETE", () => {
    const src = `app.delete("/api/v1/x", async (request) => service.rm(request.body));`;
    expect(run(src, [route("delete", "/api/v1/x")], []).violations).toEqual([]);
  });

  it("counts rawBodyOf as reading a body — a signature-verified webhook does receive a payload", () => {
    const src = `app.post("/api/v1/x", async (request) => ingest({ rawBody: rawBodyOf(request) }));`;
    const { violations } = run(src, [route("post", "/api/v1/x")], []);
    expect(violations[0]?.kind).toBe("reads-unpublished");
  });

  it("reports a route it cannot locate rather than skipping it", () => {
    // A gate that quietly cannot judge a route is the failure it exists to prevent.
    const { violations } = run("// no routes here", [route("post", "/api/v1/x")], []);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe("unreadable");
  });
});

describe("the registry cannot go stale", () => {
  it("fails when a registered route stops disagreeing, so an entry cannot outlive its reason", () => {
    // Registered entries are real routes in the repo; a route that agrees is reported as stale. Driven
    // here through the live registry: every registered key must still be a genuine disagreement.
    const { staleEntries } = checkRoutes(
      [],
      () => "",
      () => false,
    );
    // With no routes scanned, every registered entry is unmatched — which is exactly the stale signal.
    expect(staleEntries.length).toBeGreaterThan(0);
  });
});
