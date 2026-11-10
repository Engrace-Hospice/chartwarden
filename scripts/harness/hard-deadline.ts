/**
 * A hard wall-clock deadline for the whole PreToolUse guard, in BOTH Claude and Codex mode.
 *
 * A guard that is killed (SIGTERM at the hook's own 10 s timeout), crashes, or exits with anything but 2 lets
 * the tool call RUN in Claude Code. Codex's pinned command wraps the guard in `perl alarm 8 ... || exit 2`, so
 * there a hang is a refusal; Claude's pinned commands deliberately have no perl wrapper (a missing `perl` would
 * lock out every Claude tool call). So the guard enforces its own deadline: this entry thread reads stdin and
 * waits, the classification runs in a Bun Worker (`guard-worker.ts`), and when the deadline passes, or the worker
 * dies without answering, THIS thread prints the standard deny and exits 2, whatever the worker is stuck in (a
 * regular expression, a quadratic loop). Exit 2 blocks the call in both agents; the JSON is for Claude Code's
 * decision channel, the stderr line for its transcript.
 *
 * Nothing heavy is imported here: the entry thread must stay free to answer its own timer.
 */
import { writeSync } from "node:fs";

export type GuardDecision = "allow" | "ask" | "deny";

/** What the worker sends back: the decision, a reason for a non-allow, and an optional note for stderr. */
export interface GuardAnswer {
  readonly decision: GuardDecision;
  readonly reason: string;
  readonly stderr?: string;
}

/** Under Claude's 10 s hook timeout and Codex's 8 s alarm, with room for process start and a slow disk. */
export const DEADLINE_MS = 6500;
const MIN_TEST_DEADLINE_MS = 50;

/**
 * `CW_HARNESS_DEADLINE_MS_FOR_TESTS` shortens the deadline for a test that forces a hang; it can never lengthen
 * it. Production never sets it, and the shared settings must not either (`FORBIDDEN_ENV`).
 */
export function deadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  const asked = Number(env.CW_HARNESS_DEADLINE_MS_FOR_TESTS);
  return Number.isFinite(asked) && asked >= MIN_TEST_DEADLINE_MS
    ? Math.min(asked, DEADLINE_MS)
    : DEADLINE_MS;
}

const NO_ANSWER =
  "The guard did not answer in time (or its worker died), so this call is refused rather than run unjudged. Retry, or split the call into smaller ones.";

/** The standard deny, in the shape the guard always answers with. */
export function denyJson(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[chartwarden-harness] ${reason}`,
    },
  });
}

/** Synchronous: `process.stdout.write` then `exit` cut a large write to a pipe off at 64 KB. */
function write(fd: 1 | 2, text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    (fd === 1 ? process.stdout : process.stderr).write(text);
  }
}

/** Print the deny, say why on stderr, and exit 2 (blocks in Claude Code and in Codex). */
export function emergencyDeny(reason: string): never {
  write(1, denyJson(reason));
  write(2, `[chartwarden-harness] ${reason}\n`);
  process.exit(2);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run the guard worker over what stdin holds and print its answer; refuse (exit 2) when the deadline passes
 * first, when the worker errors or exits without answering, or when it cannot be started. Arms the timer BEFORE
 * stdin is read, so a hook input that never ends cannot hold the guard open either.
 */
export async function runGuard(worker: URL, codex: boolean): Promise<void> {
  const timer = setTimeout(() => emergencyDeny(NO_ANSWER), deadlineMs());
  let answered = false;
  try {
    const raw = await readStdin();
    const w = new Worker(worker.href);
    w.onmessage = (event: MessageEvent<GuardAnswer>) => {
      answered = true;
      clearTimeout(timer);
      finish(event.data);
    };
    w.onerror = () => emergencyDeny(NO_ANSWER);
    w.addEventListener("close", () => {
      if (!answered) emergencyDeny(NO_ANSWER);
    });
    w.postMessage({ raw, codex });
  } catch {
    emergencyDeny(NO_ANSWER);
  }
}

/** Print an answer the way the guard always has: JSON for a deny or ask, nothing for an allow; exit 0. */
function finish(answer: GuardAnswer): never {
  if (answer.stderr) write(2, answer.stderr);
  if (answer.decision !== "allow") {
    write(
      1,
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: answer.decision,
          permissionDecisionReason: answer.reason,
        },
      }),
    );
  }
  process.exit(0);
}
