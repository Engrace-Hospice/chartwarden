import { isRequiredHopeSection } from "@chartwarden/hope";
import type { HopeRfaKind } from "@chartwarden/types";

export interface HopeSectionedItem {
  readonly itemCode: string;
  readonly sectionLabel: string;
}

/**
 * Scope item-level edits to the RFA sections named by the authoritative CMS matrix.
 * Item applicability and conditional rules still decide requiredness within that scope.
 */
export function isRequiredHopeItemForRfa(rfaKind: HopeRfaKind, item: HopeSectionedItem): boolean {
  const section = item.sectionLabel.trim() || item.itemCode.slice(0, 1);
  return isRequiredHopeSection(rfaKind, section);
}
