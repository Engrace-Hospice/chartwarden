// WP 1.5: the channel-list preview of a message that has no text. Derived server-side from the attachment views the
// viewer is already allowed to see (clean files, plus their own still-scanning ones), so a quarantined or someone
// else's pending file name never reaches the list.
const PAPERCLIP = "\u{1F4CE}";
const MAX_NAME = 80;

export function attachmentPreviewLabel(views: readonly { fileName: string }[]): string {
  if (views.length === 0) return `${PAPERCLIP} Attachment`;
  if (views.length > 1) return `${PAPERCLIP} ${views.length} attachments`;
  const name = views[0]!.fileName;
  return `${PAPERCLIP} ${name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name}`;
}
