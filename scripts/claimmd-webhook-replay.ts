// scripts/claimmd-webhook-replay.ts — check a captured Claim.MD webhook delivery against the receiver WITHOUT changing it (CW-TX-02).
//
//   CLAIMMD_ACCOUNT_KEY='…' bun run claimmd:webhook:replay -- <capture.json | directory> [--json]
//
// OFFLINE. It reads capture files (claimmd-webhook-capture/1, see scripts/claimmd-webhook-capture.ts), opens no socket and
// writes nothing. For each capture it prints what the receiver and the sweep would make of it, with no field value in the output
// (counts, types, key names, value shapes): whether the signature verifies and, if not, which alternative reading of the scheme
// WOULD have; how the body splits into events; where it departs from the documented shape; and what the REAL webhook route
// answers to those exact bytes and headers (Fastify inject, in this process).
//
// The account key comes from the environment only (never an argument, never printed). Without it the shape is still reported and
// the signature is "not_checked". Exit 0: every capture verified and the route answered 200. Exit 1: a delivery was refused.
// Exit 2: a usage error or an unreadable capture.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type ClaimMdReplayReport,
  analyzeClaimMdCapture,
  parseClaimMdCapture,
  renderClaimMdReplayReport,
} from "@chartwarden/x12-837-client";
import {
  type ClaimMdRouteReplay,
  replayCaptureThroughRoute,
  usageOfCapture,
} from "../apps/backend/src/modules/23-billing-medicare/claimmd-webhook/replay";

const CAPTURE_SUFFIX = ".capture.json";

interface FileResult {
  readonly file: string;
  readonly report: ClaimMdReplayReport;
  readonly route: ClaimMdRouteReplay | null;
  readonly pathNote: string | null;
}

function capturesIn(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target)
    .filter((name) => name.endsWith(CAPTURE_SUFFIX))
    .sort()
    .map((name) => join(target, name));
}

async function replayFile(file: string, accountKey: string | null): Promise<FileResult | string> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return `${basename(file)}: not readable JSON`;
  }
  const parsed = parseClaimMdCapture(json);
  if (!parsed.ok) return `${basename(file)}: ${parsed.reason}`;
  const { capture, rawBody } = parsed;
  try {
    const report = analyzeClaimMdCapture({ capture, rawBody, accountKey, now: new Date() });
    const route =
      accountKey === null
        ? null
        : await replayCaptureThroughRoute({ capture, rawBody, accountKey });
    const { usage, mapped } = usageOfCapture(capture);
    return {
      file: basename(file),
      report,
      route,
      pathNote: mapped
        ? `the captured path is neither claimmd route; replayed to the ${usage} route`
        : null,
    };
  } catch {
    // one capture must not stop the rest of a directory; the error text could echo capture content, so it is not printed
    return `${basename(file)}: the replay itself failed on this capture`;
  }
}

function routeLine(route: ClaimMdRouteReplay | null): string {
  if (route === null) return "route: not replayed (no account key)";
  if (route.statusCode === 200) return `route: 200, would store ${route.received} receipt(s)`;
  const why = route.refusalTrace ? ` (trace: ${route.refusalTrace.verdict})` : "";
  return `route: ${route.statusCode} ${route.errorCode ?? ""}${why}`.trimEnd();
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const targets = args.filter((a) => !a.startsWith("--"));
  if (targets.length === 0 || args.some((a) => a.startsWith("--") && a !== "--json")) {
    console.error(
      "usage: CLAIMMD_ACCOUNT_KEY=… bun run claimmd:webhook:replay -- <capture.json | directory> [--json]",
    );
    return 2;
  }
  const accountKey = process.env.CLAIMMD_ACCOUNT_KEY || null;
  const results: FileResult[] = [];
  const problems: string[] = [];
  for (const target of targets) {
    let files: string[];
    try {
      files = capturesIn(target);
    } catch {
      problems.push(`${basename(target)}: not found`);
      continue;
    }
    if (files.length === 0) problems.push(`${basename(target)}: no ${CAPTURE_SUFFIX} files`);
    for (const file of files) {
      const result = await replayFile(file, accountKey);
      if (typeof result === "string") problems.push(result);
      else results.push(result);
    }
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    for (const r of results) {
      console.log(`== ${r.file}`);
      console.log(renderClaimMdReplayReport(r.report));
      if (r.pathNote) console.log(`note: ${r.pathNote}`);
      console.log(routeLine(r.route));
      console.log("");
    }
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0 || results.length === 0) return 2;
  return results.every((r) => r.route?.statusCode === 200) ? 0 : 1;
}

process.exit(await main());
