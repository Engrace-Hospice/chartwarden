#!/usr/bin/env bun
/**
 * ChartWarden — AI-messaging read-only gate (ADR-0095 section 4, M36 WP 6.5)
 * ---------------------------------------------------------------------------
 * The AI behind messaging summaries and reply drafts must be STRUCTURALLY unable to send a message, create a task, place an order or write a chart
 * record. "The prompt says don't" is not a control; this gate is. It fails the build when:
 *
 *  (a) a source file under apps/backend/src/modules/36-messaging/ai/ imports anything outside a closed allowlist (the send path, the drafts store,
 *      tasks, attachments, scheduled send, orders, encounters and every other module's writers are simply not importable), or its code (comments
 *      stripped) calls a write: `.insert(` / `.update(` / `.delete(` / `sendMessage` / `createTask` / `registerSeam`. The ONE audited write is the
 *      access-audit row in binding.ts (`audit(`), allowed there and nowhere else;
 *  (b) the two M32 capability rows are missing, are not high risk, do not require tenant opt-in AND clinical review, or the adapter / port contract
 *      grows a tool, function-calling or write field (`tools`, `tool_choice`, `functions`, `send`, `onToolCall`);
 *  (c) the live proof (m36-ai.live.test.ts) or its package.json script is missing.
 *
 * Test files are skipped for (a): they may import fakes. Run:  bun run arch:ai-messaging-readonly   (in `arch:fitness`)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_PHASE_1_CAPABILITIES,
  aiCapabilityGovernanceDefaults,
} from "../packages/ai-platform/src/inventory/capabilities";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const AI_DIR = "apps/backend/src/modules/36-messaging/ai";
export const CAPABILITY_KEYS = ["messaging_summarize", "messaging_draft_reply"] as const;
const LIVE_SUITE = "apps/backend/__tests__/m36-ai.live.test.ts";
const LIVE_SCRIPT = "test:m36:ai:live";

/** Every module specifier an AI-folder file may import. Anything else is a violation. */
export const IMPORT_ALLOWLIST: ReadonlySet<string> = new Set([
  "node:crypto",
  "@chartwarden/types",
  "@chartwarden/messaging", // type-only (ResolvedMessage, MessagingRouteService); the scan below rejects a value import
  "@chartwarden/audit", // binding.ts only: the access-audit row
  "@chartwarden/auth", // binding.ts only: resolveActorPermissions (a read)
  "@chartwarden/db",
  "@chartwarden/tenancy",
  "drizzle-orm",
  "../../../bootstrap/index", // getSeam: PatientReader (a read)
  "../../../bootstrap/plugins/rate-limit-store", // type-only
  "../part2-channel-gate", // readSeamPatientPrivacyFlags (a read)
  "../presence/binding", // cacheFlagRead
]);
const AUDIT_ONLY_FILES = new Set(["binding.ts"]);
const FORBIDDEN_CALLS: readonly [RegExp, string][] = [
  [/\.(insert|delete)\s*\(|\b(?:tx|db|trx|executor)\s*\.\s*update\s*\(/, "a database write"],
  [/\bsendMessage\b/, "the message send path"],
  [/\bpostMessage\b/, "the message send path"],
  [/\bcreateTask\b/, "task creation"],
  [/\bregisterSeam\b/, "seam registration"],
];
const FORBIDDEN_CONTRACT_FIELDS =
  /\b(tools?|tool_choice|toolChoice|functions?|function_call|onToolCall)\s*[?:]/;

export interface Violation {
  readonly file: string;
  readonly message: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Pure scan of one AI-folder file's text. */
export function scanAiFile(file: string, source: string): Violation[] {
  const base = file.split("/").pop() ?? file;
  const code = stripComments(source);
  const out: Violation[] = [];
  for (const m of code.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const spec = m[1] as string;
    if (spec.startsWith("./")) continue;
    if (!IMPORT_ALLOWLIST.has(spec)) {
      out.push({
        file,
        message: `imports '${spec}', which is not on the AI allowlist (the AI folder may read, never send, order or write)`,
      });
      continue;
    }
    if (
      spec === "@chartwarden/messaging" &&
      !new RegExp(`import\\s+type\\s+[^;]*from\\s+["']${spec}["']`).test(code)
    ) {
      out.push({
        file,
        message: "imports @chartwarden/messaging as a VALUE; only type imports are allowed",
      });
    }
    if (spec === "@chartwarden/audit" && !AUDIT_ONLY_FILES.has(base)) {
      out.push({
        file,
        message: "only binding.ts may import @chartwarden/audit (the single access-audit write)",
      });
    }
  }
  for (const [pattern, what] of FORBIDDEN_CALLS) {
    if (pattern.test(code)) out.push({ file, message: `calls ${what} (${pattern.source})` });
  }
  if (/(?<![.\w])audit\s*\(/.test(code) && !AUDIT_ONLY_FILES.has(base)) {
    out.push({ file, message: "writes an audit row outside binding.ts" });
  }
  return out;
}

export function scanAiFolder(root = REPO_ROOT): Violation[] {
  const dir = join(root, AI_DIR);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f));
  return files.flatMap((f) => scanAiFile(`${AI_DIR}/${f}`, readFileSync(join(dir, f), "utf8")));
}

/** (b) the capability rows and the contract files. */
export function checkCapabilityRows(root = REPO_ROOT): Violation[] {
  const out: Violation[] = [];
  for (const key of CAPABILITY_KEYS) {
    const row = AI_PHASE_1_CAPABILITIES.find((c) => c.capabilityKey === key);
    if (!row) {
      out.push({
        file: "packages/ai-platform/src/inventory/capabilities.ts",
        message: `capability '${key}' is not registered`,
      });
      continue;
    }
    const governance = aiCapabilityGovernanceDefaults(row.riskTier);
    if (row.riskTier !== "high")
      out.push({ file: key, message: "must be high risk (ADR-0095 section 5.4)" });
    if (!governance.tenantOptInRequired || !governance.clinicalReviewRequired) {
      out.push({
        file: key,
        message: "must require tenant opt-in and clinical review (the HITL control)",
      });
    }
    if (row.phase1LifecycleState !== "PROPOSED") {
      out.push({
        file: key,
        message: `lifecycle is ${row.phase1LifecycleState}; it serves nothing until M32 stage 4, so it must stay PROPOSED here`,
      });
    }
  }
  for (const file of [
    "packages/types/src/messaging-ai.ts",
    "apps/backend/src/modules/32-ai-platform/seams/messaging-ai.ts",
  ]) {
    const code = stripComments(readFileSync(join(root, file), "utf8"));
    const hit = code.match(FORBIDDEN_CONTRACT_FIELDS);
    if (hit)
      out.push({
        file,
        message: `declares '${hit[1]}': the AI contract has no tool, function-calling or write field`,
      });
  }
  return out;
}

/** (c) the live proof exists and is runnable. */
export function checkLiveProof(root = REPO_ROOT): Violation[] {
  const out: Violation[] = [];
  if (!existsSync(join(root, LIVE_SUITE)))
    out.push({ file: LIVE_SUITE, message: "the live proof of 'AI cannot write' is missing" });
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (!pkg.scripts?.[LIVE_SCRIPT])
    out.push({ file: "package.json", message: `script '${LIVE_SCRIPT}' is missing` });
  return out;
}

export function run(root = REPO_ROOT): Violation[] {
  return [...scanAiFolder(root), ...checkCapabilityRows(root), ...checkLiveProof(root)];
}

if (import.meta.main) {
  const violations = run();
  if (violations.length > 0) {
    console.error("arch:ai-messaging-readonly FAILED:");
    for (const v of violations) console.error(`  ${v.file}: ${v.message}`);
    process.exit(1);
  }
  console.log(
    "arch:ai-messaging-readonly OK — the M36 AI folder imports no send/order/write path, the capability rows are high-risk HITL, the live proof exists.",
  );
}
