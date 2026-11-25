// apps/backend/src/modules/09-assessments — the ESAS-r item scores a scale-series point carries (the composer's advisory symptom prompt).
//
// ONE place both route services (the in-memory slice and the production Drizzle service) build the optional `itemScores` field, so they
// cannot drift. Only the nine numeric scores of an `esas_r` capture travel (`esasrItemScoresFrom` drops the "other" symptom, the free-text
// note and who reported it), a redacted point withholds them with its score, and every other scale has none. The route stays behind
// `assessment.read_trend`; no permission changes.
import { type ScaleSeriesPoint, type ScaleType, esasrItemScoresFrom } from "@chartwarden/types";

/** `{ itemScores }` for an unredacted ESAS-r capture that holds all nine items, else `{}` (spread it into the point). */
export function seriesItemScores(
  scaleType: ScaleType,
  data: unknown,
  redacted: boolean,
): Pick<ScaleSeriesPoint, "itemScores"> {
  if (redacted || scaleType !== "esas_r") return {};
  const itemScores = esasrItemScoresFrom(data);
  return itemScores === undefined ? {} : { itemScores };
}
