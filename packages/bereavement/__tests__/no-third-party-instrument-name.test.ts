// ADR-0110 D5 — the 8-factor risk instrument is M16's own. No source, label, string or migration in the
// bereavement surfaces may name a licensed third-party bereavement-risk instrument. The word is assembled at
// runtime so this file does not trip its own scan.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BANNED = new RegExp(`\\b${["B", "R", "A", "T"].join("")}\\b`, "i");

/** The trees (or single files) where bereavement wording, labels and strings live. */
const SCANNED = [
  "packages/bereavement/src",
  "packages/types/src/bereavement.ts",
  "packages/db/src/schema/bereavement",
  "packages/messaging/src/seed",
  "apps/backend/src/modules/16-bereavement",
  "apps/web/src/modules/16-bereavement",
  "apps/portal/src",
  "docs/design/screens/clinical/CHARTWARDEN_UI_BEREAVEMENT.md",
] as const;
const EXTENSIONS = new Set([".ts", ".tsx", ".sql", ".md", ".json"]);

function filesUnder(path: string): string[] {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(path);
  } catch {
    return [];
  }
  if (info.isFile()) return EXTENSIONS.has(extname(path)) ? [path] : [];
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)));
}

describe("the bereavement risk instrument is not named after a third-party tool", () => {
  it("finds files to scan (guards against the scan silently matching nothing)", () => {
    const files = SCANNED.flatMap((p) => filesUnder(join(ROOT, p)));
    expect(files.length).toBeGreaterThan(40);
  });

  it("names no third-party instrument anywhere in the scanned surfaces", () => {
    const offenders = SCANNED.flatMap((p) => filesUnder(join(ROOT, p))).filter((file) =>
      BANNED.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
