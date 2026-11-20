// apps/backend/src/modules/08-encounters/findings/adl.ts — WF09: the ADL record a clinician records on one visit (pure).
//
// The PUT body is the `RecordedAdl` shape of @chartwarden/hearthnote, whose constants are the one source of truth for the stored
// values, the API and the screens. `planAdlRecord` validates the body against them (the same sets the `encounter_adl` CHECK
// constraints enforce, so a bad value is a precise 422 before it reaches the row) and returns the stored column shape;
// `recordedAdlFromRow` is the reverse mapping the note's facts read. No IO.
import {
  ADL_DEVICES,
  ADL_ITEMS,
  ADL_LEVELS,
  type AdlDevice,
  type AdlItem,
  type AdlLevel,
  CONTINENCE_LEVELS,
  type ContinenceLevel,
  type RecordedAdl,
} from "@chartwarden/hearthnote";
import { invalid, oneOfOrNull } from "./validate";

/** The PUT body. An absent or null field is "not assessed"; the PUT replaces the whole record. */
export interface AdlInput {
  readonly items?: Readonly<Partial<Record<AdlItem, AdlLevel | null>>>;
  readonly bladder?: ContinenceLevel | null;
  readonly bowel?: ContinenceLevel | null;
  readonly devices?: readonly AdlDevice[];
}

/** The stored columns of one `encounter_adl` row (the Drizzle insert shape minus ids and stamps). */
export interface AdlColumns {
  readonly bathing: AdlLevel | null;
  readonly dressing: AdlLevel | null;
  readonly grooming: AdlLevel | null;
  readonly toileting: AdlLevel | null;
  readonly transferring: AdlLevel | null;
  readonly ambulation: AdlLevel | null;
  readonly eating: AdlLevel | null;
  readonly bladder: ContinenceLevel | null;
  readonly bowel: ContinenceLevel | null;
  readonly devices: readonly AdlDevice[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reject any key of `items` that is not an ADL item (a typo must not silently drop a recorded level on a replace-whole PUT). */
function assertKnownItems(items: Record<string, unknown>): void {
  for (const key of Object.keys(items)) {
    if (!(ADL_ITEMS as readonly string[]).includes(key)) {
      invalid(`items.${key}`, `unknown ADL item; one of: ${ADL_ITEMS.join(", ")}`);
    }
  }
}

function devicesOf(value: unknown): readonly AdlDevice[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return invalid("devices", "must be an array of devices");
  const chosen = new Set<AdlDevice>();
  value.forEach((entry, index) => {
    const device = oneOfOrNull(`devices.${index}`, entry, ADL_DEVICES);
    if (device === null) invalid(`devices.${index}`, "must be a device");
    else chosen.add(device);
  });
  // Documented order, so the same set stores (and reads back) the same way however the client ordered it.
  return ADL_DEVICES.filter((d) => chosen.has(d));
}

/** Validate an ADL PUT body and return the columns it stores; throws the 422 envelope naming the first bad field. */
export function planAdlRecord(input: AdlInput): AdlColumns {
  const rawItems: unknown = input.items ?? {};
  if (!isRecord(rawItems)) return invalid("items", "must be an object");
  assertKnownItems(rawItems);
  const level = (item: AdlItem): AdlLevel | null =>
    oneOfOrNull(`items.${item}`, rawItems[item], ADL_LEVELS);
  return {
    bathing: level("bathing"),
    dressing: level("dressing"),
    grooming: level("grooming"),
    toileting: level("toileting"),
    transferring: level("transferring"),
    ambulation: level("ambulation"),
    eating: level("eating"),
    bladder: oneOfOrNull("bladder", input.bladder, CONTINENCE_LEVELS),
    bowel: oneOfOrNull("bowel", input.bowel, CONTINENCE_LEVELS),
    devices: devicesOf(input.devices),
  };
}

/** The ADL facts a note states, from a stored row: null columns and an empty device list are omitted. */
export function recordedAdlFromRow(row: AdlColumns): RecordedAdl {
  const items = Object.fromEntries(
    ADL_ITEMS.flatMap((item) => (row[item] === null ? [] : [[item, row[item]]])),
  ) as Partial<Record<AdlItem, AdlLevel>>;
  return {
    ...(Object.keys(items).length > 0 ? { items } : {}),
    ...(row.bladder === null ? {} : { bladder: row.bladder }),
    ...(row.bowel === null ? {} : { bowel: row.bowel }),
    ...(row.devices.length > 0 ? { devices: [...row.devices] } : {}),
  };
}
