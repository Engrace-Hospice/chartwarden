import { createHash } from "node:crypto";

/** Send-time facts for an institutional hospice notice. These deliberately do not model a claim or PCN. */
export interface X12NoticeEvidence {
  readonly billingNpi: string;
  readonly billingTin: string;
  readonly payerId: string;
  readonly interchangeSenderId: string;
  readonly interchangeReceiverId: string;
  readonly functionalSenderId: string;
  readonly functionalReceiverId: string;
  readonly transactionSet: "837I";
  readonly isa13: string;
  readonly gs06: string;
  readonly st02: string;
  /** CLM01 is retained only as an outbound payload namespace; it is not the notice id or an acknowledgment key. */
  readonly outboundBusinessControlNumber: string | null;
  readonly payloadSha256: string;
}

export function extractX12NoticeEvidence(
  x12: string,
  noticeKind: "noe" | "notr" | "transfer_notice",
  noticeControlNumber: string,
  usage: "test" | "production",
): X12NoticeEvidence {
  if (typeof x12 !== "string" || x12.length < 106 || !x12.startsWith("ISA")) throw new Error("INVALID_NOTICE_X12");
  const element = x12[3]; const segment = x12[105];
  if (!element || !segment || element === segment) throw new Error("INVALID_NOTICE_X12");
  const parts = x12.split(segment).map((s) => s.trim()).filter(Boolean).map((s) => s.split(element));
  const isa = parts[0];
  const isa13 = isa?.[13]?.trim() ?? "";
  if (isa?.[0] !== "ISA" || !isa13 || parts.filter((s) => s[0] === "ST").length !== 1 ||
      parts.filter((s) => s[0] === "SE").length !== 1 || parts.filter((s) => s[0] === "GS").length !== 1 ||
      parts.filter((s) => s[0] === "GE").length !== 1 || parts.filter((s) => s[0] === "IEA").length !== 1) {
    throw new Error("INVALID_NOTICE_X12");
  }
  const gs = parts.find((s) => s[0] === "GS")!;
  const st = parts.find((s) => s[0] === "ST")!;
  const se = parts.find((s) => s[0] === "SE")!;
  const ge = parts.find((s) => s[0] === "GE")!;
  const iea = parts.find((s) => s[0] === "IEA")!;
  if (gs[1]?.trim() !== "HC" || gs[8]?.trim() !== "005010X223A2" || gs[3]?.trim() !== "CLAIMMD" ||
      isa?.[8]?.trim() !== "CLAIMMD" || !isa?.[6]?.trim() || isa[6]?.trim() !== gs[2]?.trim() || st[1]?.trim() !== "837" ||
      isa[15]?.trim() !== (usage === "test" ? "T" : "P") ||
      !st[2]?.trim() || !gs[6]?.trim() || st[3]?.trim() !== gs[8]?.trim() || se[2]?.trim() !== st[2]?.trim() ||
      ge[2]?.trim() !== gs[6]?.trim() || iea[2]?.trim() !== isa13) throw new Error("UNSUPPORTED_NOTICE_X12");
  const providers = parts.filter((s) => s[0] === "NM1" && s[1] === "85");
  const payers = parts.filter((s) => s[0] === "NM1" && s[1] === "PR");
  if (providers.length !== 1 || payers.length !== 1) throw new Error("AMBIGUOUS_NOTICE_IDENTITY");
  const npi = providers[0]?.[8] === "XX" ? providers[0]?.[9]?.trim() : "";
  const tinRef = parts.filter((s) => s[0] === "REF" && s[1] === "EI");
  const tin = tinRef.length === 1 ? tinRef[0]?.[2]?.trim() : "";
  const payer = payers[0]?.[8] === "PI" ? payers[0]?.[9]?.trim() : "";
  if (!/^\d{10}$/.test(npi ?? "") || !/^\d{9}$/.test(tin ?? "") || !payer) throw new Error("INCOMPLETE_NOTICE_IDENTITY");
  const clm = parts.filter((s) => s[0] === "CLM");
  if (clm.length !== 1 || !noticeControlNumber || clm[0]?.[1]?.trim() !== noticeControlNumber) throw new Error("NOTICE_CONTROL_MISMATCH");
  const frequency = clm[0]?.[5]?.split(":")?.[2]?.trim();
  const validKind = noticeKind === "noe" ? frequency === "A" : noticeKind === "notr" ? frequency === "B" : frequency === "C" || frequency === "D";
  if (!validKind) throw new Error("NOTICE_KIND_MISMATCH");
  return { billingNpi: npi!, billingTin: tin!, payerId: payer!, interchangeSenderId: isa[6]!.trim(),
    interchangeReceiverId: isa[8]!.trim(), functionalSenderId: gs[2]!.trim(), functionalReceiverId: gs[3]!.trim(),
    transactionSet: "837I", isa13,
    gs06: gs[6]!.trim(), st02: st[2]!.trim(), outboundBusinessControlNumber: clm[0]![1]!.trim(),
    payloadSha256: createHash("sha256").update(Buffer.from(x12, "utf8")).digest("hex") };
}
