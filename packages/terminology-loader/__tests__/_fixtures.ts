// Tiny HAND-MADE fixtures for the parser/orchestrator tests. Every code and term below is invented (the licensed
// systems especially): no real SNOMED CT / LOINC / RxNorm content, and nothing here is a CMS/NCHS file excerpt.
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a ZIP; `stored` members use method 0, the rest DEFLATE. */
export function zip(entries: Record<string, string>, stored: readonly string[] = []): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, "utf8");
    const method = stored.includes(name) ? 0 : 8;
    const data = method === 0 ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** One NCHS-order-file line (fixed width: order · code · flag · short title(60) · long title). */
export const orderLine = (
  n: number,
  code: string,
  billable: 0 | 1,
  short: string,
  long: string,
): string =>
  `${String(n).padStart(5, "0")} ${code.padEnd(7)} ${billable} ${short.padEnd(60)} ${long}`;

export const ICD10CM_ORDER_2027 = [
  orderLine(1, "I42", 0, "Cardiomyopathy", "Cardiomyopathy"),
  orderLine(2, "I420", 0, "Dilated cardiomyopathy", "Dilated cardiomyopathy"),
  orderLine(
    3,
    "I4200",
    1,
    "Dilated cardiomyopathy, unspecified",
    "Dilated cardiomyopathy, unspecified",
  ),
  orderLine(
    4,
    "I4201",
    1,
    "Dilated cardiomyopathy, hypertrophic",
    "Dilated cardiomyopathy, hypertrophic",
  ),
  orderLine(
    5,
    "C509",
    0,
    "Malignant neoplasm of breast",
    "Malignant neoplasm of breast, unspecified site",
  ),
  orderLine(
    6,
    "C5091",
    1,
    "Malignant neoplasm of breast, unsp",
    "Malignant neoplasm of breast of unspecified site, female",
  ),
].join("\n");

/** Prior (FY2026) release: I42.0 was billable, then became a header; C50.91 stays. */
export const ICD10CM_ORDER_2026 = [
  orderLine(1, "I42", 0, "Cardiomyopathy", "Cardiomyopathy"),
  orderLine(2, "I420", 1, "Dilated cardiomyopathy", "Dilated cardiomyopathy"),
  orderLine(
    3,
    "C509",
    0,
    "Malignant neoplasm of breast",
    "Malignant neoplasm of breast, unspecified site",
  ),
  orderLine(
    4,
    "C5091",
    1,
    "Malignant neoplasm of breast, unsp",
    "Malignant neoplasm of breast of unspecified site, female",
  ),
  orderLine(5, "Z515", 1, "Encounter for palliative care", "Encounter for palliative care"),
].join("\n");

export const ICD10PCS_ORDER = [
  orderLine(1, "001", 0, "Central Nervous System", "Medical and Surgical, Central Nervous System"),
  orderLine(
    2,
    "0016070",
    1,
    "Bypass Cereb Vent to Nasophar",
    "Bypass Cerebral Ventricle to Nasopharynx with Autologous Tissue, Open",
  ),
].join("\n");

/** Build one HCPCS fixed-width record per the layout documented in parsers/hcpcs.ts. */
export function hcpcsRecord(f: {
  code: string;
  recId: string;
  long: string;
  short?: string;
  add?: string;
  eff?: string;
  term?: string;
}): string {
  const line = Array.from({ length: 285 }, () => " ");
  const put = (from: number, text: string): void => {
    for (let i = 0; i < text.length; i++) line[from - 1 + i] = text[i] as string;
  };
  put(1, f.code);
  put(6, "00010");
  put(11, f.recId);
  put(12, f.long);
  put(92, f.short ?? "");
  put(261, f.add ?? "");
  put(269, f.eff ?? "");
  put(277, f.term ?? "");
  return line.join("");
}

export const HCPCS_FIXED = [
  hcpcsRecord({
    code: "Q5001",
    recId: "3",
    long: "Hospice or home health care provided in patient's home/residence",
    short: "Hospice care in home",
    add: "20080101",
    eff: "20080101",
  }),
  hcpcsRecord({
    code: "G0299",
    recId: "3",
    long: "Direct skilled nursing services of a registered nurse (RN) in the home health or hospice setting",
    short: "Direct RN services",
    add: "20090101",
    eff: "20090101",
  }),
  hcpcsRecord({
    code: "G0300",
    recId: "3",
    long: "Direct skilled nursing services of a licensed practical nurse (LPN)",
    short: "Direct LPN services",
    add: "20090101",
    eff: "20090101",
    term: "20261231",
  }),
  hcpcsRecord({
    code: "G0300",
    recId: "4",
    long: "in the home health or hospice setting, each 15 minutes",
  }),
  hcpcsRecord({
    code: "26",
    recId: "7",
    long: "Professional component",
    short: "Prof component",
    eff: "20000101",
  }),
].join("\n");

export const NDC_PRODUCT =
  "PRODUCTID\tPRODUCTNDC\tPRODUCTTYPENAME\tPROPRIETARYNAME\tNONPROPRIETARYNAME\tDOSAGEFORMNAME\tROUTENAME\tSTARTMARKETINGDATE\tENDMARKETINGDATE\tLABELERNAME\tDEA_SCHEDULE\n" +
  "1111-2222_aaaa\t1111-2222\tHUMAN PRESCRIPTION DRUG\tComfortex\tmorphine sulfate\tSOLUTION\tORAL\t20100101\t\tAcme Labs\tCII\n" +
  "33333-444_bbbb\t33333-444\tHUMAN PRESCRIPTION DRUG\tCalmzine\tlorazepam\tTABLET\tORAL\t20120101\t20251231\tBeta Pharma\tCIV\n";

export const NDC_PACKAGE =
  "PRODUCTID\tPRODUCTNDC\tNDCPACKAGECODE\tPACKAGEDESCRIPTION\tSTARTMARKETINGDATE\tENDMARKETINGDATE\tNDC_EXCLUDE_FLAG\n" +
  "1111-2222_aaaa\t1111-2222\t1111-2222-03\t30 mL in 1 BOTTLE\t20100101\t\tN\n" +
  "1111-2222_aaaa\t1111-2222\t1111-2222-05\t100 mL in 1 BOTTLE\t20100101\t\tN\n" +
  "33333-444_bbbb\t33333-444\t33333-444-01\t100 TABLET in 1 BOTTLE\t20120101\t20251231\tN\n" +
  "33333-444_bbbb\t33333-444\t33333-444-99\t1 TABLET in 1 BLISTER PACK\t20120101\t\tY\n";

export const CVX_TXT = [
  "  21 |varicella|varicella virus vaccine, live|Varicella vaccine| Active |7|False|2/27/2013",
  "  54 |adenovirus, type 4|adenovirus vaccine, type 4, live, oral||Inactive|3|False|2/27/2013",
  " 999 |unspecified|Unspecified vaccine||Not Applicable|9|True|2/27/2013",
].join("\n");

export const RXNCONSO = [
  "100|ENG|P|L1|PF|S1|Y|A1||100||RXNORM|IN|100|morphine|0|N|256|",
  "200|ENG|P|L2|PF|S2|Y|A2||200||RXNORM|SCD|200|morphine 10 MG/ML Oral Solution|0|N|256|",
  "200|ENG|S|L3|VO|S3|N|A3||200||RXNORM|SY|200|morphine oral soln 10mg/mL|0|N|256|",
  "300|ENG|P|L4|PF|S4|Y|A4||300||RXNORM|BN|300|Comfortex|0|N|256|",
  "400|ENG|P|L5|PF|S5|Y|A5||400||RXNORM|SCD|400|obsolete thing|0|O|256|",
  "500|ENG|P|L6|PF|S6|Y|A6||500||MMSL|SCD|500|not rxnorm source|0|N|256|",
].join("\n");

export const RXNSAT = [
  "200|L2|S2|A2|AUI|200|ATUI1||NDC|RXNORM|11112222203|N|256|",
  "200|L2|S2|A2|AUI|200|ATUI2||NDC|RXNORM|11112222205|N|256|",
  "200|L2|S2|A2|AUI|200|ATUI3||RXN_HUMAN_DRUG|RXNORM|Y|N|256|",
].join("\n");

export const RXNREL = ["100|A1|AUI|RB|200|A2|AUI|has_ingredient|RUI1||RXNORM|||N|N||"].join("\n");

export const SNOMED_CONCEPT = [
  "id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId",
  "900001001\t20240301\t1\t900000000000207008\t900000000000074008",
  "900001002\t20240301\t1\t900000000000207008\t900000000000074008",
  "900001003\t20240301\t0\t900000000000207008\t900000000000074008",
].join("\n");

export const SNOMED_DESC = [
  "id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId",
  "1\t20240301\t1\t9\t900001001\ten\t900000000000003001\tSynthetic root finding (finding)\t9",
  "2\t20240301\t1\t9\t900001002\ten\t900000000000003001\tSynthetic child disorder (disorder)\t9",
  "3\t20240301\t1\t9\t900001002\ten\t900000000000013009\tSynthetic child synonym\t9",
].join("\n");

export const SNOMED_REL = [
  "id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId",
  "11\t20240301\t1\t9\t900001002\t900001001\t0\t116680003\t900000000000011006\t900000000000451002",
].join("\n");

export const LOINC_CSV = [
  "LOINC_NUM,COMPONENT,PROPERTY,TIME_ASPCT,SYSTEM,SCALE_TYP,METHOD_TYP,CLASS,STATUS,SHORTNAME,LONG_COMMON_NAME",
  '99990-1,Synthetic analyte,MCnc,Pt,Ser/Plas,Qn,,CHEM,ACTIVE,Synth Anl SerPl-mCnc,"Synthetic analyte [Mass/volume] in Serum or Plasma"',
  '99991-9,Old analyte,MCnc,Pt,Ser/Plas,Qn,,CHEM,DEPRECATED,Old Anl,"Old, deprecated analyte"',
].join("\n");

export const CARC_CSV =
  'code,display,effective_date,end_date\n1,"Deductible amount",2000-01-01,\nA1,"Claim/service denied.",2000-01-01,2030-12-31\n';
export const REVENUE_CSV =
  'code,display\n0651,"Hospice service - routine home care"\n0652,"Hospice service - continuous home care"\n';
