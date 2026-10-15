// WP 3.10 (ADR-0067 D2, H-04) - there is no path from a medication question to a clinical order. The medication-question
// code imports nothing from M11/M12, reads no order or prescribing permission, never inspects the question text, and no
// M36 migration or event hands anything to the order modules.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildMedicationQuestionBody } from "@wardenx/messaging";
import { describe, expect, it } from "vitest";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";

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
const isProd = (f: string) => !f.endsWith(".test.ts") && !f.endsWith("-kit.ts");

const backendModules = join(root, "apps/backend/src/modules");
const orderTrees = [
  ...readdirSync(backendModules)
    .filter((n) => /^(11|12)-/.test(n))
    .map((n) => join(backendModules, n)),
  join(root, "packages/orders"),
  join(root, "packages/dosespot"),
  join(root, "packages/emar"),
];
const m36 = join(backendModules, "36-messaging");
const questionFiles = [
  join(m36, "medication-questions"),
  join(root, "packages/messaging/src/medication-question"),
  join(root, "packages/types/src/messaging-medication-question.ts"),
]
  .flatMap((p) => (p.endsWith(".ts") ? [p] : walk(p)))
  .filter(isProd);

describe("medication-question code is order-free", () => {
  it("has source files to scan", () => {
    expect(questionFiles.length).toBeGreaterThanOrEqual(8);
  });

  it.each(questionFiles)("%s imports no order, prescribing or eMAR code", (f) => {
    const imports = [...strip(readFileSync(f, "utf8")).matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1] ?? "",
    );
    for (const spec of imports) {
      expect(spec).not.toMatch(/\/modules\/(11|12)-/);
      expect(spec).not.toMatch(/\.\.\/\.\.\/(11|12)-/);
      expect(spec).not.toMatch(/@wardenx\/(orders|dosespot|emar)/);
    }
  });

  it.each(questionFiles)(
    "%s names no m11/m12 event, no orders/prescribing key, no foreign seam",
    (f) => {
      const src = strip(readFileSync(f, "utf8"));
      expect(src).not.toMatch(/["'`]m1[12]\./);
      expect(src).not.toMatch(/["'`](?:orders|prescribing)\./);
      for (const m of src.matchAll(/getSeam\(\s*["'](\w+)["']/g)) {
        expect(m[1]).toBe("CareTeamProvider");
      }
    },
  );
});

describe("the question text is never parsed", () => {
  it.each(questionFiles)(
    "%s has no regular expression, matching, splitting or number parsing",
    (f) => {
      const src = strip(readFileSync(f, "utf8"));
      expect(src).not.toMatch(/new\s+RegExp\s*\(/);
      expect(src).not.toMatch(/[=(,:!&|?]\s*\/(?![/*])[^/\n]+\/[a-z]*\s*[).,;]/);
      expect(src).not.toMatch(/\.(match|matchAll|split|replace|replaceAll|exec|test|search)\(/);
      expect(src).not.toMatch(/\b(parseFloat|parseInt|Number)\(/);
    },
  );

  it("the service passes the text only to the body builder, once", () => {
    const src = strip(
      readFileSync(join(m36, "medication-questions/medication-question-service.ts"), "utf8"),
    );
    expect([...src.matchAll(/\ba\.text\b/g)]).toHaveLength(1);
    expect(src).toMatch(/buildMedicationQuestionBody\(a\.text,/);
  });

  it("the service authorises the link through the injected request-scoped validator before sending", () => {
    const src = strip(
      readFileSync(join(m36, "medication-questions/medication-question-service.ts"), "utf8"),
    );
    const validate = src.indexOf("await validateLinks(");
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(src.indexOf("deps.messaging.sendMessage("));
  });

  it("the builder returns text that equals its input byte for byte, order-like or not", () => {
    const text = "increase morphine to 10 mg q2h é\n\ttabs";
    const [para] = buildMedicationQuestionBody(text, null).doc.content;
    expect(para?.type === "paragraph" && para.content[0]).toEqual({ type: "text", text });
  });
});

describe("M36 holds no order permission or grant", () => {
  const m36Files = [m36, join(root, "packages/messaging/src")].flatMap(walk).filter(isProd);

  it("every orders.* / prescribing.* literal in M36 is a read-only permission", () => {
    const allowed = new Set(["prescribing.read", "orders.read"]);
    for (const f of m36Files) {
      for (const m of strip(readFileSync(f, "utf8")).matchAll(
        /["'`]((?:orders|prescribing)\.[a-z_.]+)["'`]/g,
      )) {
        expect(allowed.has(m[1] ?? ""), `${f}: ${m[1]}`).toBe(true);
      }
    }
  });

  it("no M36 migration grants orders.*, prescribing.* or emar.* to any role", () => {
    const dir = join(root, "packages/db/migrations");
    const files = readdirSync(dir).filter((n) => /m36/.test(n) && n.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(5);
    for (const n of files) {
      const sql = readFileSync(join(dir, n), "utf8").replace(/^--.*$/gm, "");
      expect(sql, n).not.toMatch(/['"](?:orders|prescribing|emar)\.[a-z_.%]*['"%]/i);
      expect(sql, n).not.toMatch(/LIKE\s+'(?:orders|prescribing|emar)\./i);
    }
  });
});

describe("no event crosses to the order modules", () => {
  it("no m36.* event declares m11 or m12 as a consumer", () => {
    for (const e of M36_OUTBOX_EVENTS) {
      if (!e.eventName.startsWith("m36.")) continue;
      expect(e.declaredConsumers, e.eventName).not.toContain("m11");
      expect(e.declaredConsumers, e.eventName).not.toContain("m12");
    }
  });

  it("no file under the order trees names an m36 event", () => {
    const hits = orderTrees.flatMap(walk).filter((f) => /["'`]m36\./.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
