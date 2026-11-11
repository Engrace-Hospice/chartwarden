/**
 * The worker the PreToolUse guard judges in (see `hard-deadline.ts`): one message in (`{ raw, codex }`: the
 * hook's stdin text and which agent drives it), one answer out. The entry thread owns the deadline, so a
 * judgement stuck in a loop costs the call, never the guard.
 *
 * `CW_HARNESS_TEST_FAULT` (`hang`, `exit` = the worker closes itself, `process-exit`, `throw`) is the seam a test uses to force each way a judgement can
 * fail and prove the entry thread still refuses the call. Production never sets it, and the shared settings must
 * not either (`FORBIDDEN_ENV`).
 */
import { judgeHook } from "./guard-judge";
import { parseHookInput } from "./io";

declare const self: Worker & { close(): void };

/**
 * No code in this worker may end the process: on bun 1.3.5 a `process.exit(0)` called in a worker exits the WHOLE
 * process silently with status 0, which Claude Code and Codex read as "allow". Made a throw, any such call (ours
 * or a dependency's) becomes an error the entry thread answers with a deny.
 */
process.exit = (): never => {
  throw new Error("process.exit is not allowed in the guard worker");
};

function forceFault(fault: string | undefined): void {
  if (fault === "hang") for (;;);
  if (fault === "exit") self.close();
  if (fault === "process-exit") process.exit(0);
  if (fault === "throw") throw new Error("forced fault");
}

self.onmessage = (event: MessageEvent<{ raw: string; codex: boolean }>) => {
  forceFault(process.env.CW_HARNESS_TEST_FAULT);
  postMessage(judgeHook(parseHookInput(event.data.raw), event.data.codex));
};
