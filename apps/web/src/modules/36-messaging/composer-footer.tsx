// The composer's trailing lines: the key hint, the (described-by) send hint, and the retryable send failure.
// Moved out of ConversationThread unchanged; the Retry button is a submit button of the surrounding form.
import type { JSX } from "react";

export function ComposerFooter({
  sendHint,
  sendError,
  sending,
}: {
  sendHint: string | null;
  sendError: string | null;
  sending: boolean;
}): JSX.Element {
  return (
    <>
      <small>Enter to send · Shift+Enter for a new line</small>
      {sendHint ? (
        <div id="messaging-send-hint" className="wx-send-hint">
          {sendHint}
        </div>
      ) : null}
      {sendError ? (
        <div role="alert" className="wx-composer-error">
          {sendError}{" "}
          <button type="submit" disabled={sending}>
            Retry
          </button>
        </div>
      ) : null}
    </>
  );
}
