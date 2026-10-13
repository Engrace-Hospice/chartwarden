// WP 2.4: a tiny in-page signal so the pinned-messages bar re-reads after a row pins or unpins, without threading a
// callback through every row. Carries only a channel id. Other people's pin changes reach the bar through the message
// list refresh (the `pinned` flag on each message), not through this.
const target = new EventTarget();
const PINS_CHANGED = "pins-changed";

export function notifyPinsChanged(channelId: string): void {
  target.dispatchEvent(new CustomEvent<string>(PINS_CHANGED, { detail: channelId }));
}

/** Subscribe to pin changes made in this tab for `channelId`; returns the unsubscribe function. */
export function onPinsChanged(channelId: string, listener: () => void): () => void {
  const handler = (event: Event): void => {
    if ((event as CustomEvent<string>).detail === channelId) listener();
  };
  target.addEventListener(PINS_CHANGED, handler);
  return () => target.removeEventListener(PINS_CHANGED, handler);
}
