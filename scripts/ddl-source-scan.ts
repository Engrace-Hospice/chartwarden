/**
 * Comment-stripped scanning helpers for check-ddl-legality (split out so they are unit-testable: the gate script
 * itself runs on import).
 */
import { blankComments } from "./check-abac-composed";

/**
 * A copy of `src` with comments removed so prose ("PARTITION BY LIST(...)" in a note) is not mistaken for DDL.
 * `.ts` sources go through the single-pass tokenizer (`//` and block comments, string/template literals respected,
 * so a `//` inside a string or a `/* // *\/` comment cannot mis-pair); SQL strips `--` and block comments.
 */
export function stripCommentsForScan(src: string, file: string): string {
  if (file.endsWith(".ts")) return blankComments(src);
  return src.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Rule 1 (ADR-0022 D1.1): a partitioned table's UNIQUE/PK index must include the partition column. */
export function findPartitionKeyViolations(src: string, file: string): string[] {
  const clean = stripCommentsForScan(src, file);
  const partCol =
    /partitionedBy\w*\(\s*['"](\w+)['"]/i.exec(clean)?.[1] ??
    /PARTITION\s+BY\s+\w+\s*\(\s*(\w+)/i.exec(clean)?.[1];
  if (!partCol) return [];
  const uniqRe =
    /uniqueIndex\([^)]*\)\.on\(([^)]*)\)|UNIQUE\s*\(([^)]*)\)|PRIMARY\s+KEY\s*\(([^)]*)\)/gi;
  const details: string[] = [];
  let um: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
  while ((um = uniqRe.exec(clean))) {
    const cols = um[1] ?? um[2] ?? um[3] ?? "";
    if (!new RegExp(`\\b${partCol}\\b`).test(cols)) {
      details.push(
        `table partitioned by '${partCol}' has a UNIQUE/PK index not including it (\`${cols.trim().slice(0, 60)}\`) — illegal in PostgreSQL (ADR-0022 D1.1)`,
      );
    }
  }
  return details;
}
