// What the API says about the MAC credential "test" must be true. The route's probe is the launch gateway's portal health check
// for the credential's jurisdiction (apps/backend/src/index.ts `macSandbox.probe`): it sends neither the secret nor the client id,
// so an answer means the MAC portal was reachable, never that the credential works (the secret is first exercised by the first real
// submission). The field names stay (`lastSandboxTestAt`, `ok`); this pins the published contract's words, which the tenant UI
// and any API reader repeat to a person who is deciding whether their credential is good.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const spec = JSON.parse(
  readFileSync(join(__dirname, "../../../docs/api/openapi.json"), "utf8"),
) as {
  paths: Record<string, Record<string, Json>>;
};
const TEST_PATH = "/api/v1/billing/mac-credentials/{providerEntityId}/test";
const HONEST = /does not validate the credential/i;

/** Every `lastSandboxTestAt` property schema reachable under a MAC credential path (either lane). */
function lastTestSchemas(): { where: string; schema: { description?: string } }[] {
  const found: { where: string; schema: { description?: string } }[] = [];
  const walk = (node: Json, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${where}[${i}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "lastSandboxTestAt") {
        found.push({ where, schema: value as { description?: string } });
      }
      walk(value, `${where}/${key}`);
    }
  };
  for (const [path, item] of Object.entries(spec.paths)) {
    if (path.includes("mac-credentials")) walk(item, path);
  }
  return found;
}

describe("the published MAC credential contract does not claim the credential was tested", () => {
  it("the test route's summary says the check does not validate the credential", () => {
    const post = spec.paths[TEST_PATH]?.post as { summary?: string };
    expect(post.summary).toMatch(HONEST);
    expect(post.summary).not.toMatch(/probe the mac portal for a providerentity's credential/i);
  });

  it("every lastSandboxTestAt a MAC credential route returns is described as a portal answer, not a credential test", () => {
    const schemas = lastTestSchemas();
    expect(schemas.length).toBeGreaterThanOrEqual(5); // list, one, upsert, test, and the operator lane's list and write
    for (const { where, schema } of schemas) {
      expect(schema.description, where).toMatch(HONEST);
    }
  });

  it("the test response's `ok` says it is the portal that answered", () => {
    const post = spec.paths[TEST_PATH]?.post as {
      responses: Record<
        string,
        {
          content: {
            "application/json": { schema: { properties: { ok: { description?: string } } } };
          };
        }
      >;
    };
    const ok = post.responses["200"]?.content["application/json"].schema.properties.ok;
    expect(ok?.description).toMatch(HONEST);
  });
});
