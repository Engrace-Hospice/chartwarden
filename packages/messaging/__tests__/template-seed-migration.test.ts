// M36 WP 2.8 - the TS platform seed (used by the in-memory service and the lint tests) and migration 1086 (what a real
// database serves) must say the same thing; so must the category list and the closed CHECK that backs it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MESSAGE_TEMPLATE_CATEGORIES,
  MESSAGE_TEMPLATE_SCOPES,
} from "../../db/src/schema/messaging/message-templates";
import { PLATFORM_MESSAGE_TEMPLATES, TEMPLATE_CATEGORIES, TEMPLATE_SCOPES } from "../src/templates";

const SQL = readFileSync(
  join(__dirname, "../../db/migrations/1086_m36_message_template.sql"),
  "utf8",
);

const ROW =
  /\('([0-9a-f-]{36})', 'platform', '([a-z_.]+)', '([a-z]+)', '([^']*)', '([^']*)', ARRAY\[([^\]]*)\](?:::text\[\])?\)/g;

describe("migration 1086 platform seed", () => {
  const rows = [...SQL.matchAll(ROW)].map((m) => ({
    id: m[1],
    templateKey: m[2],
    category: m[3],
    title: m[4],
    body: m[5],
    requiredPhrases: [...(m[6] ?? "").matchAll(/'([^']*)'/g)].map((p) => p[1]),
  }));

  it("seeds exactly the TS platform templates, text for text", () => {
    expect(rows).toEqual(
      PLATFORM_MESSAGE_TEMPLATES.map((t) => ({
        id: t.id,
        templateKey: t.templateKey,
        category: t.category,
        title: t.title,
        body: t.body,
        requiredPhrases: [...t.requiredPhrases],
      })),
    );
  });
});

describe("closed lists", () => {
  it("the TS category and scope lists equal the db mirror and the migration CHECKs", () => {
    expect([...TEMPLATE_CATEGORIES]).toEqual([...MESSAGE_TEMPLATE_CATEGORIES]);
    expect([...TEMPLATE_SCOPES]).toEqual([...MESSAGE_TEMPLATE_SCOPES]);
    const categoryCheck =
      /"message_template_category_valid" CHECK \(\s*"category" IN \(([^)]*)\)/.exec(SQL);
    expect([...(categoryCheck?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([
      ...TEMPLATE_CATEGORIES,
    ]);
    const scopeCheck = /"message_template_scope_valid" CHECK \("scope" IN \(([^)]*)\)/.exec(SQL);
    expect([...(scopeCheck?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([
      ...TEMPLATE_SCOPES,
    ]);
  });

  it("has no clinical handoff (SBAR) category: that is Phase 3", () => {
    expect(JSON.stringify([...TEMPLATE_CATEGORIES])).not.toMatch(/sbar|handoff|clinical/i);
  });
});
