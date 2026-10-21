/**
 * ChartWarden — fetch the X12 CARC / RARC code list pages and prepare them for the M38 admin load.
 *
 * WHY A SCRIPT, NOT A MIGRATION. X12 (and its code-list distributor, the Washington Publishing Company) publishes
 * CARC and RARC only as public web pages — no CSV/JSON download exists — and asserts copyright over them
 * ("Any use of any X12 work product must be compliant with US Copyright laws and X12 Intellectual Property
 * policies"; reproduction needs permission: ip@x12.org). Fetching a page anyone can read is not redistribution, but
 * committing 1,600+ of their rows into this repository (a migration) is. So the data is NOT in the repo: this script
 * fetches it on demand into a gitignored folder, parses it with the same parser the worker runs, and prints
 * what an operator needs for the load (sha256, row counts, the list's own "updated" date).
 *
 *   bun run terminology:x12:fetch [--out .terminology-downloads/x12] [--only carc|rarc]
 *
 * Then, as a platform operator (see docs/runbooks/terminology-catalog-loading.md):
 *   POST /api/v1/admin/terminology/uploads        { system, fileName, sha256 }   -> presigned PUT
 *   PUT the saved .html to the presigned URL
 *   POST /api/v1/admin/terminology/{system}/load   { version, sourceFileRef, checksum }
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LoadableSystemId, parseSource } from "@chartwarden/terminology-loader";

interface Source {
  readonly system: Extract<LoadableSystemId, "carc" | "rarc">;
  readonly url: string;
}

const SOURCES: readonly Source[] = [
  { system: "carc", url: "https://x12.org/codes/claim-adjustment-reason-codes" },
  { system: "rarc", url: "https://x12.org/codes/remittance-advice-remark-codes" },
];
const USER_AGENT = "ChartWarden-terminology-importer/1.0 (+operator-initiated; one request per list)";
const FETCH_TIMEOUT_MS = 60_000;
const UPDATED_DATE = /code-list-updated-date">\s*([^<\s][^<]*?)\s*</;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchPage(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const outDir = argValue("--out") ?? ".terminology-downloads/x12";
  const only = argValue("--only");
  const retrievedOn = new Date().toISOString().slice(0, 10);
  mkdirSync(outDir, { recursive: true });
  const todo = SOURCES.filter((s) => !only || s.system === only);
  if (todo.length === 0)
    throw new Error(`--only must be one of: ${SOURCES.map((s) => s.system).join(", ")}`);
  for (const source of todo) {
    const bytes = await fetchPage(source.url);
    const parsed = parseSource(source.system, bytes); // throws on any row it cannot read
    const file = join(outDir, `${source.system}-${retrievedOn}.html`);
    writeFileSync(file, bytes);
    const status: Record<string, number> = {};
    for (const c of parsed.concepts) status[c.status] = (status[c.status] ?? 0) + 1;
    const listUpdated = UPDATED_DATE.exec(Buffer.from(bytes).toString("utf8"))?.[1] ?? "unknown";
    console.log(
      JSON.stringify(
        {
          system: source.system,
          url: source.url,
          retrievedOn,
          listUpdatedOn: listUpdated,
          file,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          concepts: parsed.concepts.length,
          byStatus: status,
          warnings: parsed.warnings,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
