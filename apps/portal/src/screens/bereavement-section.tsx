import { Button, Glyph } from "@chartwarden/ui";
// M31 bereavement support: the loading and error states every section of the bereaved-family page shares.
import type { JSX } from "react";

export function SectionLoading({ label }: { label: string }): JSX.Element {
  return (
    <output className="wx-bereavement-skeleton" aria-label={label}>
      <span />
      <span />
      <span />
    </output>
  );
}
export function SectionError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="wx-bereavement-section-state" role="alert">
      <Glyph name="alert-circle" size={22} aria-hidden="true" />
      <div>
        <strong>Information unavailable</strong>
        <p>{message}</p>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
