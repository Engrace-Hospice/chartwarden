// apps/backend/src/modules/08-encounters/drafting/audit-retention.ts — the retention class of an explicit audit event about a drafted section
// (S1; ADR-0114 VN-D13). A section the compiler marked Part 2 derived files its event under the Part 2 retention class, as the row triggers of
// 1517 / 1518 / 1523 file the rows; every other section stays in the 7-year compliance class.
import type { RetentionClass } from "@chartwarden/audit";

export const retentionClassOf = (part2Derived: boolean): RetentionClass =>
  part2Derived ? "compliance_42cfr_part2" : "compliance";
