/**
 * The worker the PreToolUse guard judges in (see `hard-deadline.ts`): one message in (`{ raw, codex }`: the
 * hook's stdin text and which agent drives it), one answer out. The entry thread owns the deadline, so a
 * judgement stuck in a loop costs the call, never the guard.
 *
 * `CW_HARNESS_TEST_FAULT` (`hang`, `exit`, `throw`) is the seam a test uses to force each way a judgement can
 * fail and prove the entry thread still refuses the call. Production never sets it, and the shared settings must
 * not either (`FORBIDDEN_ENV`).
 */
import { judgeHook } from "./guard-judge";
import { parseHookInput } from "./io";

declare const self: Worker;

function forceFault(fault: string | undefined): void {
  if (fault === "hang") for (;;);
  if (fault === "exit") process.exit(0);
  if (fault === "throw") throw new Error("forced fault");
}

self.onmessage = (event: MessageEvent<{ raw: string; codex: boolean }>) => {
  forceFault(process.env.CW_HARNESS_TEST_FAULT);
  postMessage(judgeHook(parseHookInput(event.data.raw), event.data.codex));
};
