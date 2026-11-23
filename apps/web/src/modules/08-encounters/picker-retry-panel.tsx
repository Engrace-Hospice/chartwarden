// apps/web/src/modules/08-encounters — the panel a composer list picker shows when its list could not be read: one warning region, any refusal that is still
// standing, and a "Try again" button that keeps its place while it reads again. Shared by the discipline plan picker (S4b) and the IDG action item picker (S5b).
import { Button, InlineAlert, Panel } from "@chartwarden/ui";
import type { GlyphName } from "@chartwarden/ui";
import type { JSX, ReactNode, RefObject } from "react";

export interface PickerRetryPanelProps {
  /** The picker's focus anchor (`useSerializedListPicker`): the panel takes the focus when the button that held it gives way. */
  readonly anchor: RefObject<HTMLFieldSetElement>;
  readonly title: string;
  readonly icon: GlyphName;
  /** What failed, in words; changes with the attempt, so a reader of the region hears that a retry failed again. */
  readonly words: string;
  /** A refused change whose re-read failed too: the person is still told the change was not saved. */
  readonly problem: string | null;
  /** A read is out: the button says so and does nothing, but stays on the page (and keeps the focus). */
  readonly reading: boolean;
  readonly onRetry: () => void;
  /** Other controls that still work with the list unread, beside "Try again". */
  readonly children?: ReactNode;
}

export function PickerRetryPanel({
  anchor,
  title,
  icon,
  words,
  problem,
  reading,
  onRetry,
  children,
}: PickerRetryPanelProps): JSX.Element {
  return (
    <fieldset ref={anchor} tabIndex={-1} className="wx-fieldset-reset">
      <legend className="wx-sr-only">{title}</legend>
      <Panel title={title} icon={icon} stack>
        {/* One region for the first failure and the next: its text changing is what a reader who cannot see the button is told. */}
        <InlineAlert tone="warning">{words}</InlineAlert>
        {problem ? <InlineAlert tone="error">{problem}</InlineAlert> : null}
        <div>
          <Button tone="secondary" size="sm" aria-disabled={reading || undefined} onClick={onRetry}>
            {reading ? "Trying again…" : "Try again"}
          </Button>
          {children}
        </div>
      </Panel>
    </fieldset>
  );
}
