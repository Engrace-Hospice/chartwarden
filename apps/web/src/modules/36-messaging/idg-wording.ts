// WP 3.6 - every user-facing string of the IDG discussions section. PROVISIONAL: the clinical lead may change them here.
export const IDG_WORDING = {
  title: "IDG discussions",
  error: "IDG discussions could not be loaded.",
  empty: "No IDG discussions in this conversation.",
  notice:
    "Discussing here does not change the IDG meeting or the plan of care. Decisions are recorded in IDG and care-plan screens.",
  open: "Open discussion",
  noText: "Attachment",
  reply: (count: number): string => (count === 1 ? "1 reply" : `${count} replies`),
  openLabel: (author: string): string => `Open discussion started by ${author}`,
  unknownAuthor: "Unknown author",
} as const;
