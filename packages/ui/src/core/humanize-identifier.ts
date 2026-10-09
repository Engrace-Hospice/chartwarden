const ACRONYMS: Readonly<Record<string, string>> = {
  ai: "AI",
  api: "API",
  cms: "CMS",
  evv: "EVV",
  hipaa: "HIPAA",
  id: "ID",
  idg: "IDG",
  lpn: "LPN",
  noe: "NOE",
  notr: "NOTR",
  phi: "PHI",
  rn: "RN",
  sos: "SOS",
  sp: "Spiritual",
};

/**
 * Turns an internal enum/event key into a user-facing fallback label.
 *
 * The original value remains the API/filter value; this helper is display-only. Product-owned labels
 * should still be preferred when the API already provides one.
 */
export function humanizeIdentifier(value: string): string {
  const segments = value.trim().split(".").filter(Boolean);

  if (/^m\d+$/i.test(segments[0] ?? "") || segments[0]?.toLowerCase() === "nv") {
    segments.shift();
  }

  return segments
    .join(" ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const acronym = ACRONYMS[word.toLowerCase()];
      if (acronym) return acronym;
      if (/^[A-Z\d]+$/.test(word)) return word;
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}
