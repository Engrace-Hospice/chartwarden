/** The latched "history may have a hole" warning. Cleared only by the parent (a replace load or a channel switch). */
export function CatchUpGapNotice({ onReload }: { readonly onReload: () => void }) {
  return (
    <output className="wx-thread-refresh-warning">
      Some messages may be missing.{" "}
      <button type="button" onClick={onReload}>
        Reload
      </button>
    </output>
  );
}

export function RefreshErrorNotice({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <output className="wx-thread-refresh-warning">
      Connection interrupted.{" "}
      <button type="button" onClick={onRetry}>
        Retry now
      </button>
    </output>
  );
}
