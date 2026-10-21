// FIXTURE — intentional violation: M8 reaches into M12's schema directly.
// Proves check-table-ownership.ts goes RED (cross-module schema access).
import { medicationOrder } from "@chartwarden/db/schema/med";
export const leak = medicationOrder;
