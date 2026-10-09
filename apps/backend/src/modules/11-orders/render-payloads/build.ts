// apps/backend/src/modules/11-orders/render-payloads/build.ts - the typed render payload M11 hands M22 for a signed
// order (GAP-033). It runs INSIDE the signing transaction on the order's own row, so the PDF is a snapshot of what
// was signed. The kind-specific lines are derived ONLY for kinds (and versions) with a published field contract
// (packages/orders ORDER_KIND_CONTRACT_STATUS / the closed dme.v2 + supply.v2 schemas); for the others the
// payload says so (`detailsNote`) instead of dumping an open object, because `dme.v1`, `supply.v1` and
// `ancillary_service.v1` are explicitly extensible and carry no reviewed field names.
import type { schema } from "@wardenx/db";
import { ORDER_KIND_CONTRACT_STATUS } from "@wardenx/orders";
import {
  type ORDER_RECORD_KINDS,
  type OrderRecordRenderPayload,
  RENDER_PAYLOAD_VERSION,
  type RenderDetailLine,
  type SignatureRecord,
  assertOrderRecordRenderPayload,
} from "@wardenx/types";
import {
  type RenderBuildCtx,
  RenderPayloadBuildError,
  membershipPrintedName,
} from "../../../bootstrap/render-payload-sources";

type OrderRow = typeof schema.orderRecords.$inferSelect;
type Rec = Readonly<Record<string, unknown>>;
type OrderKindName = (typeof ORDER_RECORD_KINDS)[number];

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const yesNo = (v: unknown): string => (v === true ? "Yes" : "No");

const LEVEL_LABELS: Readonly<Record<string, string>> = {
  rhc: "Routine home care",
  chc: "Continuous home care",
  irc: "Inpatient respite care",
  gip: "General inpatient care",
};
const levelLabel = (v: unknown): string => LEVEL_LABELS[text(v) ?? ""] ?? text(v) ?? "-";

/** A line is kept only when it has a value. */
function lines(...candidates: ReadonlyArray<readonly [string, string | null]>): RenderDetailLine[] {
  return candidates.flatMap(([label, value]) => (value === null ? [] : [{ label, value }]));
}

export const NO_PUBLISHED_CONTRACT_NOTE =
  "No reviewed field contract is published for this order kind, so its specifics are not reproduced on this page. They are held on the order in the chart.";

const SKU_VERSIONS: ReadonlySet<string> = new Set(["dme.v2", "supply.v2"]);

async function detailLines(
  ctx: RenderBuildCtx,
  kind: OrderKindName,
  kindVersion: string,
  data: Rec,
): Promise<{ details: RenderDetailLine[]; note: string | null }> {
  if (SKU_VERSIONS.has(kindVersion)) {
    const sku = text(data.skuId);
    return {
      note: null,
      details: lines(
        ["Catalog item reference", sku === null ? null : sku.slice(0, 8)],
        ["Quantity", typeof data.quantity === "number" ? String(data.quantity) : null],
        ["Unit", text(data.unit)],
        ["Rental cadence", text(data.rentalCadence)],
        [
          "Installation needed",
          data.needsInstallation === undefined ? null : yesNo(data.needsInstallation),
        ],
        [
          "Patient education needed",
          data.needsPatientEducation === undefined ? null : yesNo(data.needsPatientEducation),
        ],
      ),
    };
  }
  if (ORDER_KIND_CONTRACT_STATUS[kind] !== "canonical_contract_found") {
    return { details: [], note: NO_PUBLISHED_CONTRACT_NOTE };
  }
  switch (kind) {
    case "lab": {
      const tests = (Array.isArray(data.testCodes) ? data.testCodes : []).map((t) => {
        const r = rec(t);
        return `${text(r.display) ?? "Test"} (LOINC ${text(r.code) ?? "-"})`;
      });
      return {
        note: null,
        details: lines(
          ["Tests", tests.length > 0 ? tests.join("; ") : null],
          ["Fasting required", yesNo(data.fastingRequired)],
          ["Specimen source", text(data.specimenSource)],
          ["Collection instructions", text(data.collectionInstructions)],
          ["Clinical justification", text(data.clinicalJustification)],
          ["Notes", text(data.notes)],
        ),
      };
    }
    case "level_of_care_change":
      return {
        note: null,
        details: lines(
          ["From level of care", levelLabel(data.fromLevel)],
          ["To level of care", levelLabel(data.toLevel)],
          ["Effective", text(data.effectiveAt)],
          [
            "Expected duration",
            typeof data.expectedDurationHours === "number"
              ? `${data.expectedDurationHours} hours`
              : null,
          ],
          ["Clinical justification", text(data.clinicalJustification)],
        ),
      };
    case "comfort_kit":
      return {
        note: null,
        details: lines(
          ["Kit", text(data.kitSku)],
          ["Deployment site", text(data.deploymentSite)],
          [
            "Preferred delivery window",
            isRec(data.preferredDeliveryWindow)
              ? `${text(data.preferredDeliveryWindow.startAt) ?? "-"} to ${text(data.preferredDeliveryWindow.endAt) ?? "-"}`
              : null,
          ],
          ["Notes", text(data.notes)],
        ),
      };
    case "recertification": {
      const certifier = await ctx.sources.physician(
        ctx.organizationId,
        text(data.certifyingPhysicianMdmId) ?? "",
      );
      return {
        note: null,
        details: lines(
          ["Period end date", text(data.periodEndDate)],
          ["Certifying physician", certifier?.name ?? null],
        ),
      };
    }
    case "idg_requested":
      return {
        note: null,
        details: lines(
          ["Requested interdisciplinary group action", text(data.requestedKind)],
          ["Narrative", text(data.narrative)],
          ["Recommended timeframe", text(data.recommendedTimeframe)],
        ),
      };
    default:
      return { details: [], note: NO_PUBLISHED_CONTRACT_NOTE };
  }
}

export interface OrderSigning {
  readonly signerMembershipId: string;
  readonly signedAt: Date;
  readonly viaVerbal: boolean;
  /** The membership the order was signed on behalf of (a cosigning delegate), when it was. */
  readonly onBehalfOfMembershipId?: string | null;
  /** True for a spawned standing-order instance: the signature is the template's, inherited (D5). */
  readonly inheritedFromStandingOrder?: boolean;
}

async function signatureOf(
  ctx: RenderBuildCtx,
  order: OrderRow,
  signing: OrderSigning,
): Promise<SignatureRecord> {
  const printedName = await membershipPrintedName(ctx.tx, signing.signerMembershipId);
  if (printedName === null) {
    throw new RenderPayloadBuildError("order_record", "the signer's name did not resolve");
  }
  const onBehalfName = signing.onBehalfOfMembershipId
    ? await membershipPrintedName(ctx.tx, signing.onBehalfOfMembershipId)
    : null;
  const capacity = signing.inheritedFromStandingOrder
    ? "Standing order authorization"
    : onBehalfName !== null
      ? `On behalf of ${onBehalfName}`
      : null;
  return {
    role: "Ordering clinician",
    printedName,
    credentials: null,
    npi: null,
    capacity,
    signedAt: signing.signedAt.toISOString(),
    method: "electronic",
    meaning: "order_authorization",
    recordId: order.id,
  };
}

export async function buildOrderRecordRenderPayload(
  ctx: RenderBuildCtx,
  order: OrderRow,
  signing: OrderSigning,
): Promise<OrderRecordRenderPayload> {
  const patient = await ctx.sources.patient(ctx.organizationId, order.patientId);
  if (!patient || patient.name.trim() === "" || patient.mrn.trim() === "") {
    throw new RenderPayloadBuildError("order_record", "the patient's name / MRN did not resolve");
  }
  const physician = await ctx.sources.physician(ctx.organizationId, order.orderingPhysicianMdmId);
  const { details, note } = await detailLines(
    ctx,
    order.kind as OrderKindName,
    order.kindVersion,
    rec(order.data),
  );
  const payload: OrderRecordRenderPayload = {
    schemaVersion: RENDER_PAYLOAD_VERSION,
    orderId: order.id,
    patient: {
      patientId: order.patientId,
      name: patient.name,
      mrn: patient.mrn,
      dateOfBirth: patient.dateOfBirth,
    },
    hospiceName: await ctx.hospiceName(order.providerEntityId ?? null),
    kind: order.kind as OrderKindName,
    kindVersion: order.kindVersion,
    priority: order.priority,
    indication: text(order.indicationText),
    orderingPhysician: physician
      ? { name: physician.name, credentials: physician.credentials, npi: physician.npi }
      : null,
    details,
    detailsNote: note,
    viaVerbal: signing.viaVerbal,
    replacesOrderId: order.replacesOrderId ?? null,
    fromStandingOrder: order.standingOrderId !== null,
    cosign: order.cosignRequired ? { required: true, status: order.cosignStatus ?? null } : null,
    signature: await signatureOf(ctx, order, signing),
  };
  return assertOrderRecordRenderPayload(payload);
}
