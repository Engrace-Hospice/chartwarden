// WP 3.7 (ADR-0063 D14) - there is no path from a message to a clinical order. The allowed targets are the closed pair
// m8/encounter_addendum and m14/idg_agenda_item everywhere (TypeBox-bound constant, DB CHECK); no M11 / M12 / orders /
// medications code mentions chart promotion; and the promotion code names no order, medication or prescribing target.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CHART_PROMOTION_TARGETS, isChartPromotionTarget } from "@wardenx/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

const backendModules = join(root, "apps/backend/src/modules");
const orderTrees = [
  ...readdirSync(backendModules)
    .filter((n) => /^(11|12)-/.test(n))
    .map((n) => join(backendModules, n)),
  join(root, "packages/orders"),
  join(root, "packages/dosespot"),
  join(root, "packages/emar"),
];
const promotionFiles = [
  join(root, "apps/backend/src/modules/36-messaging/promotions"),
  join(root, "packages/messaging/src/promotions"),
  join(root, "packages/types/src/messaging-promotion.ts"),
].flatMap((p) => (p.endsWith(".ts") ? [p] : walk(p)));

describe("no order path from chart promotion", () => {
  it("the target list is exactly the two chart targets", () => {
    expect(CHART_PROMOTION_TARGETS.map((t) => `${t.module}/${t.kind}`)).toEqual([
      "m8/encounter_addendum",
      "m14/idg_agenda_item",
    ]);
    for (const [module, kind] of [
      ["m11", "order"],
      ["m11", "orders"],
      ["m12", "medication"],
      ["m8", "order"],
    ]) {
      expect(isChartPromotionTarget(module as string, kind as string)).toBe(false);
    }
  });

  it("no M11, M12, orders, dosespot or emar file mentions chart promotion", () => {
    const hits = orderTrees
      .flatMap(walk)
      .filter((f) => /chart[_-]?promotion|ChartPromotion/i.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("promotion code names no m11 / m12 target and no order, medication or prescribing literal", () => {
    expect(promotionFiles.length).toBeGreaterThan(8);
    for (const f of promotionFiles.filter(
      (p) => !p.endsWith(".test.ts") && !p.endsWith("-kit.ts"),
    )) {
      const src = strip(readFileSync(f, "utf8"));
      expect(src, f).not.toMatch(/["'`]m1[12]["'`]/);
      expect(src, f).not.toMatch(/["'`](?:orders?|medications?|prescri\w*)["'`]/i);
    }
  });

  it("the migration CHECK text excludes m11, order and medication", () => {
    const sql = strip(
      readFileSync(
        join(root, "packages/db/migrations/1102_m36_m8_m14_chart_promotion.sql"),
        "utf8",
      ).replace(/^--.*$/gm, ""),
    );
    const check =
      /CONSTRAINT "chart_promotion_request_target"\s+CHECK \(([^;]*?)\),\s*CONSTRAINT/.exec(sql);
    expect(check?.[1]).toBeDefined();
    expect(check?.[1]).not.toMatch(/m11|m12|order|medication/i);
  });
});
