/**
 * Accepted ADRs that no docs/architecture document cites yet (arch:architecture-sync, rule ADRS).
 *
 * This is DEBT, not an allowlist: each entry is an Accepted decision the authoritative architecture does not
 * mention, so a reader (human or agent) of the architecture alone would not know about it. The list only shrinks:
 * citing an ADR in the owning architecture section or changelog makes the gate demand its removal here, and a NEW
 * Accepted ADR is never added here; it must be cited. Regenerate the body with
 * `bun run scripts/check-architecture-sync.ts --print-baseline`.
 */
export const UNCITED_ACCEPTED_ADRS: readonly string[] = [
  "0015",
  "0016",
  "0017",
  "0018",
  "0019",
  "0023",
  "0024",
  "0025",
  "0027",
  "0031",
  "0033",
  "0042",
  "0044",
  "0046",
  "0047",
  "0052",
  "0054",
  "0055",
  "0059",
  "0060",
  "0061",
  "0062",
  "0063",
  "0064",
  "0065",
  "0066",
  "0067",
  "0068",
  "0069",
  "0070",
  "0071",
  "0073",
  "0075",
  "0077",
  "0078",
  "0080",
  "0081",
  "0088",
  "0105",
];
