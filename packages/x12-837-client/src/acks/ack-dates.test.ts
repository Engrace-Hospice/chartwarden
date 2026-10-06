// The payer's own dates on a NOE / NOTR acknowledgment: 277CA STC02 per claim, and the 999's GS04 / ISA09.
import { describe, expect, it } from "vitest";
import { read277caStatusDates, read999EnvelopeDates } from "./ack-dates";

const ISA =
  "ISA*00*          *00*          *ZZ*NGSJ6          *ZZ*SUBMITTER      *260308*1415*^*00501*000000101*0*P*:~";

const ACK_999 = [
  ISA,
  "GS*FA*NGSJ6*SUBMITTER*20260308*1415*101*X*005010X231A1~",
  "ST*999*0001*005010X231A1~",
  "AK1*HC*42*005010X223A2~",
  "AK9*R*1*1*0~",
  "SE*4*0001~",
  "GE*1*101~",
  "IEA*1*000000101~",
].join("\n");

const ACK_277CA = [
  ISA,
  "GS*HN*NGSJ6*SUBMITTER*20260308*1415*102*X*005010X214~",
  "ST*277*0002*005010X214~",
  "BHT*0085*08*277X214*20260308*1415*TH~",
  "HL*1**20*1~",
  "NM1*PR*2*NGS*****PI*06001~",
  "TRN*1*BATCH01~",
  "DTP*050*D8*20260308~",
  "DTP*009*D8*20260308~",
  "HL*2*1*21*1~",
  "NM1*41*2*HOSPICE*****46*SUB1~",
  "TRN*2*SUBMITBATCH~",
  "STC*A1:19:PR*20260306*WQ*0~",
  "HL*3*2*19*1~",
  "NM1*85*2*HOSPICE*****XX*1234567893~",
  "HL*4*3*PT~",
  "NM1*QC*1*DOE*JANE****MI*1EG4TE5MK73~",
  "TRN*2*H00001-260301-0abcd-00~",
  "STC*A1:20:PR*20260307*WQ*0~",
  "REF*1K*PAYER-ICN-1~",
  "HL*5*3*PT~",
  "NM1*QC*1*ROE*RICK****MI*2EG4TE5MK74~",
  "TRN*2*H00001-260302-0bcde-00~",
  "STC*A7:562:85**U*0~",
  "SE*21*0002~",
  "GE*1*102~",
  "IEA*1*000000101~",
].join("\n");

describe("read999EnvelopeDates", () => {
  it("reads GS04 (CCYYMMDD) and ISA09 (YYMMDD) as ISO dates", () => {
    expect(read999EnvelopeDates(ACK_999)).toEqual({
      functionalGroupDate: "2026-03-08",
      interchangeDate: "2026-03-08",
    });
  });

  it("returns nulls for a malformed GS04 rather than guessing", () => {
    expect(
      read999EnvelopeDates(ACK_999.replace("*20260308*1415*101", "*2026030*1415*101")),
    ).toEqual({ functionalGroupDate: null, interchangeDate: "2026-03-08" });
  });
});

describe("read277caStatusDates", () => {
  it("returns each claim's STC02 status effective date keyed by its TRN02 control number", () => {
    expect(read277caStatusDates(ACK_277CA)).toEqual([
      { claimControlNumber: "H00001-260301-0abcd-00", statusEffectiveDate: "2026-03-07" },
      { claimControlNumber: "H00001-260302-0bcde-00", statusEffectiveDate: null },
    ]);
  });

  it("never returns PHI (no names, no MBIs)", () => {
    const out = JSON.stringify(read277caStatusDates(ACK_277CA));
    expect(out).not.toMatch(/DOE|JANE|1EG4TE5MK73/);
  });
});
