/**
 * ChartWarden - architecture-corpus freshness gate (AG-01/AG-02)
 * ----------------------------------------------------------
 * The authority rule makes docs/architecture/ binding over module specs, yet until 2026-08-14 it
 * was the only body of documentation with no gate: it drifted for two months while every other
 * corpus stayed pinned (see audit/ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md §2 — 63 dead
 * repo paths, stale companion citations, an open-items table citing unrelated ADRs). This gate
 * mechanically enforces the four string/filesystem invariants that would have caught the bulk of
 * that drift on the commit that introduced it:
 *
 *   1. PATHS       — every repo path a doc cites must exist on disk. A path on a line that itself
 *                    says the path does not exist ("does not exist", "never built", …) is exempt:
 *                    documented absence is the correct state, not drift.
 *   2. VERSION     — a doc whose filename carries a version must have a parseable `**Status:** vX.Y`
 *                    header; if header != filename version, the header must carry the adopted
 *                    convention note ("the FILENAME still reads") — files are gate-locked in place
 *                    and never renamed per revision; the header is authoritative.
 *   3. COMPANIONS  — every `Companion to: CHARTWARDEN_X vN.M` citation must match the cited doc's
 *                    on-disk HEADER version (not its filename version).
 *   4. ADRS        — every four-digit `ADR-NNNN` citation must resolve to a file in docs/adr/.
 *                    (The short-numbered `ADR-00N` register in ARCHITECTURE §21 is a separate,
 *                    deliberately ungated namespace — see that section's numbering note.)
 *
 * AG-02 (warn-only): each doc should end with a `<!-- verified-against: … -->` stamp recording when
 * it was last checked against the codebase; a missing or >180-day-old stamp warns but never fails.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { group, groups } from "./lib/strict";

const ROOT = process.cwd();
const DOCS_DIR = "docs/architecture";
const ADR_DIR = "docs/adr";
const STAMP_WARN_DAYS = 180;

/** Top-level repo directories a cited path may start with (anything else is not treated as a path claim). */
const PATH_PREFIXES = /^(apps|packages|scripts|docs|architecture|audit|ops|e2e|\.github)\//;

/**
 * A line that itself asserts nonexistence exempts the paths on it — the doc is documenting absence
 * (divergence banners, "never built" corrections), which is exactly what we want it to keep doing.
 */
const ABSENCE_LINE =
  /does not exist|do not exist|doesn.t exist|never existed|never created|never built|not created|nonexistent|no longer exists|NOT BUILT|NOT IMPLEMENTED|was never|neither exists|none of (these|which) exist|there is\s+\*{0,2}no|not yet (created|written|built|shipped|present)|\bdeferred\b|\btarget[ -]state\b|TARGET —/i;

/**
 * Deliberate citations of nonexistent paths on lines the ABSENCE_LINE heuristic cannot see
 * (e.g. a table row whose "does not exist" text sits in a different cell than the token, or a
 * banned-path citation). Keyed by doc basename; values are exact cited tokens with the reason.
 */
const PATH_ALLOWLIST: Record<string, ReadonlyArray<{ token: string; reason: string }>> = {
  "ARCHITECTURE_25_15_FITNESS.md": [
    {
      token: "packages/foundation",
      reason: "cited because it is BANNED (ADR-0005) — must never exist",
    },
  ],
  "CHARTWARDEN_ARCHITECTURE_v0_11.md": [
    {
      token: "packages/saas",
      reason:
        "divergence-banner mapping row: 'this document says' cell deliberately cites the dead name",
    },
    {
      token: "apps/mobile",
      reason:
        "historical changelog rows + §4 heading; superseded by ADR-0035 (Capacitor wrap of apps/web, no separate app)",
    },
  ],
};

interface Violation {
  readonly doc: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

const violations: Violation[] = [];
const warnings: string[] = [];

function fail(doc: string, line: number, rule: string, message: string): void {
  violations.push({ doc, line, rule, message });
}

/** `_v0_11.md` and `v0.2.md` filename styles both occur; return "0.11" / "0.2" / null. */
function filenameVersion(name: string): string | null {
  const m = name.match(/_?v(\d+)[._](\d+)\.md$/);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** Parse the `**Status:** vX.Y …` header version from the first 15 lines. */
function headerVersion(text: string): { version: string | null; headerBlock: string } {
  const head = text.split("\n").slice(0, 15).join("\n");
  const m = head.match(/\*\*Status:\*\*\s*\*{0,2}v(\d+\.\d+)/);
  return { version: m ? group(m, 1, "architecture doc header version") : null, headerBlock: head };
}

/** Strip trailing line-refs and punctuation from a cited path token. */
function cleanToken(raw: string): string {
  return raw
    .replace(/:[\d,\-–]+$/, "") // `path.ts:361-371` line citations
    .replace(/[.,;)\]}>'"`]+$/, "")
    .replace(/\/$/, "");
}

/** A token is a checkable path claim only if it is concrete — no globs/placeholders/ellipses. */
function isConcretePath(token: string): boolean {
  if (!PATH_PREFIXES.test(token)) return false;
  if (/[*?<>{}|\\]|…|\.\.\./.test(token)) return false;
  if (/NN|XX|_vX[._]Y|\/mN[-._/]/.test(token)) return false;
  if (/%[a-zA-Z]/.test(token)) return false;
  return true;
}

const docFiles = readdirSync(join(ROOT, DOCS_DIR))
  .filter((f) => f.endsWith(".md"))
  .sort();

/** doc id ("ARCHITECTURE") → { file, headerVersion } for companion resolution. */
const docIndex = new Map<string, { file: string; version: string | null }>();
const docTexts = new Map<string, string>();
for (const file of docFiles) {
  const text = readFileSync(join(ROOT, DOCS_DIR, file), "utf8");
  docTexts.set(file, text);
  const idMatch = file.match(/^CHARTWARDEN_([A-Z0-9_]+?)_v\d/);
  if (idMatch)
    docIndex.set(group(idMatch, 1, "architecture doc filename id"), {
      file,
      version: headerVersion(text).version,
    });
}

const adrFiles = readdirSync(join(ROOT, ADR_DIR)).filter((f) => /^ADR-\d{4}-/.test(f));
const adrNumbers = new Set(adrFiles.map((f) => f.slice(4, 8)));

let pathsChecked = 0;
let pathsExempt = 0;
let companionsChecked = 0;
let adrsChecked = 0;

for (const file of docFiles) {
  const text = docTexts.get(file) ?? "";
  const lines = text.split("\n");
  const allow = new Map((PATH_ALLOWLIST[file] ?? []).map((a) => [a.token, a.reason]));

  // Rule 2 — version header discipline (only for version-carrying filenames).
  const fnVersion = filenameVersion(file);
  if (fnVersion) {
    const { version: hdrVersion, headerBlock } = headerVersion(text);
    if (!hdrVersion) {
      fail(
        file,
        1,
        "VERSION",
        `filename carries v${fnVersion} but no parseable \`**Status:** vX.Y\` header found`,
      );
    } else if (hdrVersion !== fnVersion && !/FILENAME still reads/i.test(headerBlock)) {
      fail(
        file,
        1,
        "VERSION",
        `header is v${hdrVersion}, filename is v${fnVersion}, and the header lacks the "the FILENAME still reads" convention note (files are never renamed; the header must say so explicitly)`,
      );
    }
  }

  let inFence = false;
  for (const [i, line] of lines.entries()) {
    const lineNo = i + 1;

    // Fences toggle on ``` — including inside blockquoted banners ("> ```").
    if (/^\s*>?\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }

    // Rule 1 — cited repo paths exist. A path *citation* is either inline code (`…`) or a line of
    // a fenced block; bare prose slashes ("audit/auth/tenancy helper packages") are not path claims.
    const segments: string[] = inFence
      ? [line]
      : Array.from(line.matchAll(/`([^`]+)`/g), (m) => group(m, 1, "inline-code segment"));
    for (const segment of segments) {
      if (segment.includes("://")) continue; // URLs are not repo paths
      for (const raw of segment.matchAll(
        /[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+(?::[\d,\-–]+)?/g,
      )) {
        const matched = raw[0];
        const nextChar = segment[(raw.index ?? 0) + matched.length] ?? "";
        // A token truncated by a glob/brace/placeholder is not a checkable claim.
        if (nextChar !== "" && "{*<".includes(nextChar)) continue;
        const token = cleanToken(matched);
        if (token.endsWith("-") || !isConcretePath(token)) continue;
        pathsChecked++;
        if (existsSync(join(ROOT, token))) continue;
        // Documented absence exempts — on this line, or the previous one when a sentence wraps.
        const previous = i > 0 ? (lines[i - 1] ?? "") : "";
        if (ABSENCE_LINE.test(line) || ABSENCE_LINE.test(previous)) {
          pathsExempt++;
          continue;
        }
        if (allow.has(token)) {
          pathsExempt++;
          continue;
        }
        fail(file, lineNo, "PATHS", `cites \`${token}\` which does not exist in the repo`);
      }
    }

    // Rule 3 — companion citations match on-disk header versions.
    if (/\*\*Companion to:\*\*/.test(line)) {
      for (const m of line.matchAll(/CHARTWARDEN_([A-Z0-9_]+)\s+v(\d+\.\d+)/g)) {
        const [id, cited] = groups(m, 2, "companion citation");
        companionsChecked++;
        const target = docIndex.get(id);
        if (!target) {
          fail(
            file,
            lineNo,
            "COMPANIONS",
            `cites companion CHARTWARDEN_${id} v${cited}, but no such doc exists in ${DOCS_DIR}`,
          );
        } else if (target.version !== null && target.version !== cited) {
          fail(
            file,
            lineNo,
            "COMPANIONS",
            `cites CHARTWARDEN_${id} v${cited}, but ${target.file} declares v${target.version} in its header`,
          );
        }
      }
    }

    // Rule 4 — four-digit ADR citations resolve.
    for (const m of line.matchAll(/\bADR-(\d{4})\b/g)) {
      adrsChecked++;
      const cited = group(m, 1, "architecture doc ADR citation");
      if (!adrNumbers.has(cited)) {
        fail(file, lineNo, "ADRS", `cites ADR-${cited}, which has no file in ${ADR_DIR}`);
      }
    }
  }

  // AG-02 — warn-only verification stamp.
  const stamp = text.match(
    /<!--\s*verified-against:\s*([0-9a-f]{7,40})\s*·\s*(\d{4}-\d{2}-\d{2})\s*-->/,
  );
  if (!stamp) {
    warnings.push(`${file}: no \`<!-- verified-against: <sha> · <date> -->\` stamp (warn-only)`);
  } else {
    const stampedOn = group(stamp, 2, "verified-against stamp date");
    const ageDays = (Date.now() - new Date(stampedOn).getTime()) / 86_400_000;
    if (ageDays > STAMP_WARN_DAYS) {
      warnings.push(
        `${file}: verified-against stamp is ${Math.floor(ageDays)} days old (> ${STAMP_WARN_DAYS}; warn-only)`,
      );
    }
  }
}

for (const w of warnings) console.warn(`WARN architecture-docs: ${w}`);

if (violations.length === 0) {
  console.log(
    `OK architecture-docs: ${docFiles.length} docs · ${pathsChecked} path citations (${pathsExempt} documented-absent) · ${companionsChecked} companion citations · ${adrsChecked} ADR citations`,
  );
  process.exit(0);
}

console.error(`FAIL architecture-docs: ${violations.length} violation(s)`);
for (const v of violations) console.error(`  - ${v.doc}:${v.line} [${v.rule}] ${v.message}`);
process.exit(1);
