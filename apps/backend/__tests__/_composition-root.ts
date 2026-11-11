// Helpers for tests that pin how the composition root (`src/index.ts`) wires something: a green gate proves a binding or a dependency
// exists on paper, not that the root passes it, so these read the root's own text.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const COMPOSITION_ROOT = readFileSync(join(__dirname, "..", "src", "index.ts"), "utf8");

/**
 * The text of the balanced `callee(<leading>{ ... })` call, from the callee name to its closing brace. `leading` is whatever precedes the
 * object argument (`"app, "` for `registerX(app, { ... })`).
 */
export function callArgument(source: string, callee: string, leading = ""): string {
  const opening = `${callee}(${leading}{`;
  const start = source.indexOf(opening);
  if (start < 0) throw new Error(`no call to ${callee} in the composition root`);
  let depth = 0;
  for (let i = start + opening.length - 1; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced call to ${callee}`);
}
