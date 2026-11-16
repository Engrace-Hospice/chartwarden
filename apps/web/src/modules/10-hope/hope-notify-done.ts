// apps/web/src/modules/10-hope — what a dialog does once its write has been answered: tell its caller (refresh, navigate,
// or on a 409 re-read) and close. Those callbacks are the caller's code and run OUTSIDE the write's try on purpose (a throw
// there must not read as "nothing was recorded"), so a throw is reported — never swallowed, and never an unhandled rejection
// from the async submit — and the rest still run: the write landed (or was refused), and the dialog has to settle however the
// caller behaved.
export function notifyDone(...callbacks: ReadonlyArray<() => void>): void {
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      globalThis.reportError?.(error);
    }
  }
}
