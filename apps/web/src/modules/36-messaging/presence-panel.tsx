// WP 2.12 presentational pieces: the "Online now" members section and the typing indicator under the composer.
// Status is TEXT (a heading and a visually-hidden "online"), never only the colour of the dot.
import type { JSX } from "react";
import "./presence.css";
import { typingLabel } from "./presence-utils";
import type { PresenceView } from "./use-presence";

const MAX_LISTED = 8;

export function PresenceMembers({ presence }: { presence: PresenceView }): JSX.Element | null {
  if (!presence.active || presence.onlineNames.length === 0) return null;
  const listed = presence.onlineNames.slice(0, MAX_LISTED);
  const more = presence.onlineNames.length - listed.length;
  return (
    <section className="wx-presence" aria-label="People online in this conversation">
      <h3 className="wx-presence-title">Online now</h3>
      <ul className="wx-presence-list">
        {listed.map((name, index) => (
          // Names can repeat ("A colleague"); the list is read-only and re-rendered whole, so the index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <li key={`${name}-${index}`} className="wx-presence-item">
            <span className="wx-presence-dot" aria-hidden="true" />
            {name}
            <span className="wx-sr-only"> (online)</span>
          </li>
        ))}
        {more > 0 ? <li className="wx-presence-item">and {more} more</li> : null}
      </ul>
    </section>
  );
}

/** The live region stays mounted while presence is active so a change of text is announced politely. */
export function TypingIndicator({ presence }: { presence: PresenceView }): JSX.Element | null {
  if (!presence.active) return null;
  const label = typingLabel(presence.typingNames);
  return (
    <output className="wx-typing-indicator" aria-live="polite">
      {label}
    </output>
  );
}
