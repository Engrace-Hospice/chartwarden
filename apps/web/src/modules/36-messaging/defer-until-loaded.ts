/**
 * A queued message the server just confirmed, arriving before the thread's first read has landed. Merging it now would
 * be overwritten by that read (whose snapshot may predate the commit) and would disable the initial scroll, and its
 * pending row is already gone. So leave it to the load and ask for one more read right after it (the thread's
 * `rereadAfterFlight`), which picks the message up. Returns true when it deferred.
 */
export function deferUntilLoaded(
  messagesRef: { readonly current: unknown },
  rereadAfterFlight: { current: boolean },
  onMessageSent: () => void,
): boolean {
  if (messagesRef.current !== null) return false;
  rereadAfterFlight.current = true;
  onMessageSent();
  return true;
}
