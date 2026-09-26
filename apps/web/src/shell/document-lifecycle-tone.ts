// apps/web/src/shell/document-lifecycle-tone.ts — the visual tone for an M22 document lifecycle status.
// Shared-shell because the document workspace (`./document-workflows.tsx`) is embedded by M6's admission
// and referral screens as well as M22's own, and M22 already depends on M6 (an M6→M22 edge would cycle the
// module graph). M22's `lantern.tsx` re-exports it for its own screens.
import type { StatusTone } from "@wardenx/ui";

/**
 * Map an M22 document/render/intake lifecycle status to a §6.6 status tone (§6.6 "document/render"
 * lifecycle: queued → rendering → rendered → failed; plus the intake batch + review states). The
 * server is authoritative for the status string; this is only the visual tone.
 */
export function lifecycleTone(status: string): StatusTone {
  const s = status.toLowerCase();
  if (/(fail|error|parse_failed|stalled)/.test(s)) return "error";
  if (/(rendered|complete|writeback_complete|active|signed|posted)/.test(s)) return "success";
  if (
    /(rendering|classif|extract|review|awaiting|pending|uploaded|in_progress|queued|docling)/.test(
      s,
    )
  )
    return "progress";
  if (/(discard|void|superseded|abandoned|split_resolved)/.test(s)) return "neutral";
  return "neutral";
}
