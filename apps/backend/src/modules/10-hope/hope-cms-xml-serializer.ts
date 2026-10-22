import { createHash } from "node:crypto";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { renderCmsAssessmentXml } from "./hope-cms-xml-render";
import { OPTIONAL_ASSESSMENT_ITEMS } from "./hope-readiness-service";
import type { HopeIsc } from "./hope-spec-registry";
import {
  type HopeSubmissionHeader,
  HopeSubmissionPayloadError,
  controlItemValue,
} from "./hope-submission-header";

const VALIDATION_PROFILE = "HOPE-1.00.1-ERRATA-1.00.3";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;
type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
type AnswerRow = typeof schema.hopeAssessmentAnswers.$inferSelect;

export interface SerializedHopeXml {
  readonly xml: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly filename: string;
  readonly operation: "add" | "modify" | "inactivate";
  readonly validationProfile: string;
}

export { HopeSubmissionPayloadError };

function answerToCmsValue(answer: AnswerRow | undefined): string {
  if (!answer)
    throw new HopeSubmissionPayloadError(
      "Missing canonical HOPE answer",
      "WX-HOPE-SUBMISSION-MISSING-ANSWER",
    );
  if (answer.state === "skipped") return "^";
  if (answer.value == null) {
    throw new HopeSubmissionPayloadError(
      "Answered HOPE item has a null value",
      "WX-HOPE-SUBMISSION-NULL-ANSWER",
    );
  }
  if (typeof answer.value === "string") return answer.value;
  if (typeof answer.value === "number" || typeof answer.value === "boolean")
    return String(answer.value);
  throw new HopeSubmissionPayloadError(
    "Nested HOPE answer values cannot be serialized to CMS XML",
    "WX-HOPE-SUBMISSION-UNSERIALIZABLE-ANSWER",
  );
}

function operationFromA0050(value: string): SerializedHopeXml["operation"] {
  if (value === "1") return "add";
  if (value === "2") return "modify";
  if (value === "3") return "inactivate";
  throw new HopeSubmissionPayloadError(
    "A0050 does not identify a CMS submission operation",
    "WX-HOPE-SUBMISSION-OPERATION",
  );
}

function filenameFor(input: {
  readonly assessmentId: string;
  readonly isc: HopeIsc;
  readonly operation: SerializedHopeXml["operation"];
  readonly targetDate: Date;
}): string {
  const date = input.targetDate.toISOString().slice(0, 10).replaceAll("-", "");
  return `HOPE_${input.isc}_${input.operation.toUpperCase()}_${date}_${input.assessmentId}.xml`;
}

/**
 * How many times this record's lineage has been corrected: 0 for an original, n for the nth correction
 * (each correction row points at the record it corrects via `corrects_assessment_id`). CRCTN_NUM.
 */
async function correctionNumberFor(tx: DbClient, assessment: AssessmentRow): Promise<number> {
  let depth = 0;
  let next = assessment.correctsAssessmentId;
  const seen = new Set<string>([assessment.id]);
  while (next) {
    if (seen.has(next) || depth > 99) {
      throw new HopeSubmissionPayloadError(
        "HOPE correction chain is cyclic or longer than CMS allows",
        "WX-HOPE-SUBMISSION-CORRECTION-CHAIN",
      );
    }
    seen.add(next);
    depth += 1;
    const [parent] = await tx
      .select({ correctsAssessmentId: schema.hopeAssessments.correctsAssessmentId })
      .from(schema.hopeAssessments)
      .where(
        and(
          eq(schema.hopeAssessments.id, next),
          eq(schema.hopeAssessments.organizationId, assessment.organizationId),
        ),
      )
      .limit(1);
    if (!parent) break;
    next = parent.correctsAssessmentId;
  }
  return depth;
}

export async function serializeHopeAssessmentXml(
  tx: DbClient,
  assessment: AssessmentRow,
  header: HopeSubmissionHeader,
): Promise<SerializedHopeXml> {
  if (assessment.status !== "signed") {
    throw new HopeSubmissionPayloadError(
      "Only signed HOPE assessments can be serialized",
      "WX-HOPE-SUBMISSION-NOT-SIGNED",
    );
  }
  if (!assessment.specVersionId || !assessment.isc) {
    throw new HopeSubmissionPayloadError(
      "HOPE assessment has no frozen CMS spec/ISC",
      "WX-HOPE-SUBMISSION-SPEC-UNAVAILABLE",
    );
  }
  const [version] = await tx
    .select()
    .from(schema.hopeSpecVersions)
    .where(eq(schema.hopeSpecVersions.id, assessment.specVersionId))
    .limit(1);
  if (!version) {
    throw new HopeSubmissionPayloadError(
      "Frozen CMS spec version is unavailable",
      "WX-HOPE-SUBMISSION-SPEC-UNAVAILABLE",
    );
  }
  const itemRows = await tx
    .select({ item: schema.hopeSpecItems })
    .from(schema.hopeSpecItems)
    .innerJoin(
      schema.hopeSpecItemIsc,
      eq(schema.hopeSpecItemIsc.specItemId, schema.hopeSpecItems.id),
    )
    .where(
      and(
        eq(schema.hopeSpecItems.specVersionId, assessment.specVersionId),
        eq(schema.hopeSpecItemIsc.isc, assessment.isc as HopeIsc),
        eq(schema.hopeSpecItemIsc.active, true),
        inArray(schema.hopeSpecItems.kind, ["assessment", "control"]),
      ),
    )
    .orderBy(asc(schema.hopeSpecItems.sectionSortOrder), asc(schema.hopeSpecItems.itemSortOrder));
  const items = itemRows.map((row) => row.item as SpecItemRow);
  const answers = await tx
    .select()
    .from(schema.hopeAssessmentAnswers)
    .where(eq(schema.hopeAssessmentAnswers.hopeAssessmentId, assessment.id));
  const answersByItem = new Map(answers.map((answer) => [answer.specItemId, answer as AnswerRow]));
  const a0050 = items.find((item) => item.itemCode === "A0050");
  const a0050Value = answerToCmsValue(a0050 ? answersByItem.get(a0050.id) : undefined);
  const operation = operationFromA0050(a0050Value);
  if (operation === "inactivate" && assessment.isc !== "XX") {
    throw new HopeSubmissionPayloadError(
      "Inactivation payloads must use ISC XX",
      "WX-HOPE-SUBMISSION-OPERATION",
    );
  }
  if (operation !== "inactivate" && assessment.isc === "XX") {
    throw new HopeSubmissionPayloadError(
      "XX payloads must be CMS inactivation records",
      "WX-HOPE-SUBMISSION-OPERATION",
    );
  }

  // Control items (the CMS submission header) are computed, never read from answers.
  const controlIds = items.filter((item) => item.kind === "control").map((item) => item.id);
  const controlOptions =
    controlIds.length === 0
      ? []
      : await tx
          .select({
            specItemId: schema.hopeSpecItemOptions.specItemId,
            valueCode: schema.hopeSpecItemOptions.valueCode,
          })
          .from(schema.hopeSpecItemOptions)
          .where(inArray(schema.hopeSpecItemOptions.specItemId, controlIds));
  const itemIdByCode = new Map(items.map((item) => [item.itemCode, item.id]));
  const optionsFor = (code: string): readonly string[] => {
    const id = itemIdByCode.get(code);
    return controlOptions.filter((o) => o.specItemId === id).map((o) => o.valueCode);
  };
  const correctionNumber = await correctionNumberFor(tx, assessment);

  const xml = renderCmsAssessmentXml(
    items.map((item) => {
      if (item.kind === "control") {
        return {
          itemCode: item.itemCode,
          value: controlItemValue(item.itemCode, {
            isc: assessment.isc as string,
            header,
            correctionNumber,
            optionsFor,
          }),
        };
      }
      const answer = answersByItem.get(item.id);
      // An optional item readiness allowed to stay unanswered (e.g. no middle initial) is the CMS
      // blank `^` ("not available or unknown"), not a missing answer.
      return {
        itemCode: item.itemCode,
        value:
          !answer && OPTIONAL_ASSESSMENT_ITEMS.has(item.itemCode) ? "^" : answerToCmsValue(answer),
      };
    }),
  );
  // renderCmsAssessmentXml guarantees printable ASCII, so utf8 and ascii bytes are identical.
  const bytes = Buffer.from(xml, "ascii");
  return {
    xml,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    filename: filenameFor({
      assessmentId: assessment.id,
      isc: assessment.isc as HopeIsc,
      operation,
      targetDate: assessment.targetDate,
    }),
    operation,
    validationProfile: VALIDATION_PROFILE,
  };
}
