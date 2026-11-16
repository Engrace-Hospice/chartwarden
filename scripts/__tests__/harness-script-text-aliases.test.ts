/**
 * Wave 7, T5, CR5-8 (mutant P6 of the round-5 review): `aliasNormalise` in `scriptTextVerdict` was removed by a hand
 * mutant and no test noticed. It is not redundant: inline code is judged as TEXT, and a name spelled with a character the
 * file system folds into an ASCII one (U+017F LONG S is `s`, U+212A KELVIN SIGN is `k`, U+00DF SHARP S is `ss`) is the
 * same file on APFS but not the same string. `classifyBash` is pure: root, home and cwd are injected. Secret names are
 * spelled from parts so this file never writes one whole.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const LONG_S = "ſ";
const KELVIN = "K";
const SHARP_S = "ß";
const SSH_DIR = `.s${LONG_S}h`;
const KEY = ["id", "rsa"].join("_");

describe("inline code that names a file through a folded spelling is judged as the ASCII name", () => {
  it.each([
    [`python3 -c "open('~/${SSH_DIR}/${KEY}').read()"`, "deny"],
    [`node -e "require('fs').readFileSync('${SSH_DIR}/${KEY}')"`, "deny"],
    [`python3 -c "open('.claude/hoo${KELVIN}s/x','w')"`, "ask"],
    [`python3 -c "open('scripts/harne${SHARP_S}/pre-tool-guard.ts','w')"`, "ask"],
    [`bun -e "await Bun.write('scripts/harne${SHARP_S}/hard-deadline.ts','')"`, "ask"],
  ])("%s answers %s", (cmd, expected) => {
    expect(d(cmd), cmd).toBe(expected);
  });

  // A script on stdin is read only as text (no argument carries it), so this is the layer that has to fold the spelling.
  it.each([
    [`python3 - <<'EOF'\nopen('~/${SSH_DIR}/${KEY}').read()\nEOF`, "deny"],
    [`node - <<'EOF'\nrequire('fs').readFileSync('${SSH_DIR}/${KEY}')\nEOF`, "deny"],
    [`python3 - <<'EOF'\nopen('scripts/harne${SHARP_S}/hard-deadline.ts','w')\nEOF`, "ask"],
    [`python3 - <<< "open('.claude/hoo${KELVIN}s/x','w')"`, "ask"],
  ])("a script on stdin: %s answers %s", (cmd, expected) => {
    expect(d(cmd), cmd).toBe(expected);
  });

  it.each([
    "python3 -c \"print('hello')\"",
    "node -e \"console.log('scripts are fine')\"",
    `python3 -c "print('café ${LONG_S}o')"`,
  ])("ordinary text with the same characters stays allowed: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});
