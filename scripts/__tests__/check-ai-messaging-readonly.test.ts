import { describe, expect, it } from "vitest";
import { run, scanAiFile } from "../check-ai-messaging-readonly";

describe("arch:ai-messaging-readonly", () => {
  it("flags an import of the send path, the drafts store, tasks or another module", () => {
    for (const spec of [
      "../messaging-write-core",
      "../messaging-route-service-db",
      "../drafts/draft-service-db",
      "../tasks/task-service",
      "../../11-orders/index",
    ]) {
      const hits = scanAiFile("ai/x.ts", `import { y } from "${spec}";`);
      expect(hits.map((h) => h.message).join()).toContain("not on the AI allowlist");
    }
  });

  it("allows the closed allowlist and sibling files", () => {
    expect(
      scanAiFile(
        "ai/ai-service.ts",
        'import { a } from "./ai-output";\nimport { b } from "@chartwarden/types";',
      ),
    ).toEqual([]);
    expect(scanAiFile("ai/x.ts", 'import type { R } from "@chartwarden/messaging";')).toEqual([]);
  });

  it("flags a value import of @chartwarden/messaging and an audit import outside binding.ts", () => {
    expect(scanAiFile("ai/x.ts", 'import { createX } from "@chartwarden/messaging";')).toHaveLength(
      1,
    );
    expect(
      scanAiFile("ai/x.ts", 'import { audit } from "@chartwarden/audit";\naudit(tx, c, e);').length,
    ).toBeGreaterThan(0);
    expect(
      scanAiFile("ai/binding.ts", 'import { audit } from "@chartwarden/audit";\naudit(tx, c, e);'),
    ).toEqual([]);
  });

  it("flags writes, a send and task creation, but not the same words in comments", () => {
    expect(scanAiFile("ai/x.ts", "await tx.insert(t).values(v);").length).toBeGreaterThan(0);
    expect(scanAiFile("ai/x.ts", "await svc.sendMessage(x);").length).toBeGreaterThan(0);
    expect(scanAiFile("ai/x.ts", "createTask(x);").length).toBeGreaterThan(0);
    expect(scanAiFile("ai/x.ts", "// never sendMessage or .insert( here\nconst a = 1;")).toEqual(
      [],
    );
  });

  it("is green on the tree", () => {
    expect(run()).toEqual([]);
  });
});
