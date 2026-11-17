/**
 * A hard wall-clock deadline for the whole PreToolUse guard, in BOTH Claude and Codex mode.
 *
 * A guard that is killed (SIGTERM at the hook's own 10 s timeout), crashes, or exits with anything but 2 lets
 * the tool call RUN in Claude Code. Codex's pinned command wraps the guard in `perl alarm 8 ... || exit 2`, so
 * there a hang is a refusal; Claude's pinned command has no perl wrapper (a missing `perl` would lock out every
 * Claude tool call), only a plain-shell `|| { …; exit 2; }` tail that turns a guard that cannot start or crashes
 * into a refusal but never sees a hang. So the guard enforces its own deadline: this entry thread reads stdin and
 * waits, the classification runs in a Bun Worker (`guard-worker.ts`), and when the deadline passes, or the worker
 * dies without answering, THIS thread prints the standard deny and exits 2, whatever the worker is stuck in (a
 * regular expression, a quadratic loop). Exit 2 blocks the call in both agents; the JSON is for Claude Code's
 * decision channel, the stderr line for its transcript.
 *
 * Nothing heavy is imported here: the entry thread must stay free to answer its own timer. Each emergency deny is also
 * written to the agent ledger (HIPAA 164.312(b)), by a child process that runs AFTER the deny is out, under a hard
 * timeout, with its output thrown away (`emergency-ledger.ts`): the deny never waits on the ledger and never changes.
 */
import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/**
 * Synchronous: `process.stdout.write` then `exit` cut a large write to a pipe off at 64 KB. `writeSync` may write
 * less than it was given (a full pipe), so it is called until every byte is out; if it throws, what is left goes
 * through the stream.
 */
function write(fd: 1 | 2, text: string): void {
  const bytes = Buffer.from(text);
  let done = 0;
  try {
    while (done < bytes.length) done += writeSync(fd, bytes, done);
  } catch {
    (fd === 1 ? process.stdout : process.stderr).write(bytes.subarray(done));
  }
}

/** Why the entry thread refused, and what it knew of the call: what the ledger line is written from. */
interface Emergency {
  /** Which of the ways a judgement can fail this was; the ledger line carries it, never the call. */
  readonly cause: string;
  /** The hook input as read so far (empty when stdin had not ended); the child parses it. */
  readonly raw: string;
  readonly codex: boolean;
}

/**
 * The longest the entry thread waits for the ledger child. The deadline is 6.5 s, Codex's alarm 8 s and Claude's hook
 * timeout 10 s; the deny is already written when the child starts, so even a child that is killed at this bound leaves
 * 0.5 s before the earliest of them. A line that does not make it is lost, and the deny is not.
 */
export const LEDGER_TIMEOUT_MS = 1000;
/** Past this the hook input is not handed to the ledger child: the line then names no tool. */
const MAX_LEDGER_INPUT_CHARS = 8_000_000;
/** The flags the pinned hook commands give `bun`: a bunfig, a dotenv file or a tsconfig in the session directory must not load. */
const CHILD_BUN_FLAGS = ["--config=/dev/null", "--no-env-file", "--tsconfig-override=/dev/null"];
const LEDGER_CHILD = fileURLToPath(new URL("./emergency-ledger.ts", import.meta.url));

/**
 * One ledger line for an emergency deny, written by a child process under a hard timeout; never throws, never waits
 * longer than `LEDGER_TIMEOUT_MS`, and does nothing when the ledger is off. The child is killed, not waited for, past the
 * bound (a file system that hangs cannot be bounded from inside the thread that waits on it).
 */
function ledgerEmergency(reason: string, { cause, raw, codex }: Emergency): void {
  if (process.env.CW_AGENT_LEDGER === "off") return;
  try {
    spawnSync(
      process.execPath,
      [
        ...CHILD_BUN_FLAGS,
        LEDGER_CHILD,
        codex ? "--codex" : "--claude",
        `emergency deny (${cause}): ${reason}`,
      ],
      {
        input: raw.length > MAX_LEDGER_INPUT_CHARS ? "" : raw,
        timeout: LEDGER_TIMEOUT_MS,
        killSignal: "SIGKILL",
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
  } catch {
    // The deny is already out: a ledger that cannot be reached is a lost line, never a changed answer.
  }
}

/** Print the deny, say why on stderr, write the ledger line, and exit 2 (blocks in Claude Code and in Codex). */
function emergencyDeny(reason: string, emergency?: Emergency): never {
  write(1, denyJson(reason));
  write(2, `[chartwarden-harness] ${reason}\n`);
  if (emergency) ledgerEmergency(reason, emergency);
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
  let raw = "";
  const refuse = (cause: string): never => emergencyDeny(NO_ANSWER, { cause, raw, codex });
  const timer = setTimeout(() => refuse("deadline"), deadlineMs());
  let answered = false;
  try {
    raw = await readStdin();
    const w = new Worker(worker.href);
    w.onmessage = (event: MessageEvent<GuardAnswer>) => {
      answered = true;
      clearTimeout(timer);
      finish(event.data, { cause: "malformed answer", raw, codex });
    };
    w.onerror = () => refuse("worker error");
    w.addEventListener("close", () => {
      if (!answered) refuse("worker closed");
    });
    w.postMessage({ raw, codex });
  } catch {
    refuse("worker could not start");
  }
}

const DECISIONS: ReadonlySet<unknown> = new Set(["allow", "ask", "deny"]);
const MALFORMED_ANSWER =
  "The guard's worker answered with something that is not a decision, so this call is refused rather than run unjudged.";

/**
 * Print an answer the way the guard always has: JSON for a deny or ask, nothing for an allow; exit 0. An answer that is
 * not an object with a decision of `allow`, `ask` or `deny` prints no decision and would exit 0, which both agents read
 * as an allow: it is refused instead. Exported for its test.
 */
export function finish(answer: GuardAnswer, malformed?: Emergency): never {
  if (typeof answer !== "object" || answer === null || !DECISIONS.has(answer.decision)) {
    emergencyDeny(MALFORMED_ANSWER, malformed);
  }
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
