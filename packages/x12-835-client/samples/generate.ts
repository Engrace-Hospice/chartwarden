// Synthetic hospice 835 samples (no PHI: invented names/ids, SYNTH* parties). `SAMPLES` is the single source of
// truth; `__tests__/samples.test.ts` fails if a committed `.835` drifts from it. Regenerate the files with:
//   bun packages/x12-835-client/samples/generate.ts
// These round-trip OUR parser, so they pin its current behaviour; they say nothing about how a real MAC formats
// a remit (that needs de-identified real files — see #671).
import { writeFileSync } from "node:fs";
import { wrap835, wrap835Sets } from "../__tests__/fixtures-835";

const hdr = (
  trn: string,
  payer: string,
  dtm = "20260616",
  payee = "N1*PE*SYNTH HOSPICE*XX*1999999999",
) => [
  `TRN*1*${trn}*1512345678`,
  "REF*EV*RECV01",
  `DTM*405*${dtm}`,
  `N1*PR*${payer}*XV*99999`,
  "N3*1 TEST WAY",
  "N4*TESTVILLE*ZZ*00000",
  payee,
  "LX*1",
];
const bpr = (amt: string, method = "ACH*CCP") =>
  `BPR*I*${amt}*C*${method}*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615`;

const bodies: Record<string, string[]> = {
  // 1 claim, routine home care, fully paid. 1500.00
  "01-clean-routine-home-care": [
    bpr("1500.00"),
    ...hdr("EFT1001", "SYNTHETIC MAC"),
    "CLP*PCN-1001*1*1500.00*1500.00*0.00*MA*ICN-1001*813*1",
    "NM1*QC*1*DOE*JANE****MI*1AA1AA1AA11",
    "DTM*232*20260501",
    "DTM*233*20260531",
    "SVC*HC:Q5001*1500.00*1500.00*0651*10",
    "DTM*472*20260501",
  ],
  // paid + denied (CO-18) + partial with PR on the claim. 800 + 0 + 350 = 1150.00
  "02-mixed-paid-denied-partial": [
    bpr("1150.00"),
    ...hdr("EFT1002", "SYNTHETIC MAC"),
    "CLP*PCN-2001*1*800.00*800.00*0.00*MA*ICN-2001*813",
    "NM1*QC*1*ROE*RICHARD****MI*2BB2BB2BB22",
    "SVC*HC:Q5001*800.00*800.00*0651*5",
    "CLP*PCN-2002*4*600.00*0.00*0.00*MA*ICN-2002*813",
    "NM1*QC*1*POE*PAT****MI*3CC3CC3CC33",
    "CAS*CO*18*600.00",
    "MOA***MA130",
    "CLP*PCN-2003*1*500.00*350.00*50.00*MA*ICN-2003*813",
    "NM1*QC*1*LOE*LEE****MI*4DD4DD4DD44",
    "CAS*PR*2*50.00",
    "CAS*CO*45*100.00",
  ],
  // reversal (CLP02=22, negative paid) + rebill + PLB WO recoupment. (-700 + 900) - 120 = 80.00
  "03-reversal-rebill-plb": [
    bpr("80.00"),
    ...hdr("EFT1003", "SYNTHETIC MAC", "20260617"),
    "CLP*PCN-3001*22*-700.00*-700.00*0.00*MA*ICN-3001R*813",
    "NM1*QC*1*DOE*JANE****MI*1AA1AA1AA11",
    "CLP*PCN-3001*1*900.00*900.00*0.00*MA*ICN-3001B*813",
    "NM1*QC*1*DOE*JANE****MI*1AA1AA1AA11",
    "SVC*HC:Q5005*900.00*900.00*0656*3",
    "PLB*1512345678*20261231*WO:OVR3001*120.00",
  ],
  // partial payment with two service lines: sum(SVC02) = CLP03 = 1000, sum(SVC03) = CLP04 = 850,
  // sum(line PR) = CLP05 = 100. Each line balances: charge - paid = its CAS total.
  "04-partial-with-service-lines": [
    bpr("850.00"),
    ...hdr("EFT1004", "SYNTHETIC MAC"),
    "CLP*PCN-4001*1*1000.00*850.00*100.00*MA*ICN-4001*813",
    "NM1*QC*1*ROE*RICHARD****MI*2BB2BB2BB22",
    "SVC*HC:Q5001*600.00*510.00*0651*6",
    "CAS*PR*2*60.00",
    "CAS*CO*45*30.00",
    "SVC*HC:Q5002*400.00*340.00*0652*4",
    "CAS*PR*2*40.00",
    "CAS*CO*45*20.00",
  ],
  // claim-level AMT*I interest. The parser reads and discards AMT, so BPR must equal CLP04 (interest is NOT
  // added to the balance check); see samples.test.ts for the BPR 1012.34 variant.
  "05-interest-amt-i": [
    bpr("1000.00"),
    ...hdr("EFT1005", "SYNTHETIC MAC"),
    "CLP*PCN-5001*1*1000.00*1000.00*0.00*MA*ICN-5001*813",
    "NM1*QC*1*DOE*JANE****MI*1AA1AA1AA11",
    "AMT*I*12.34",
    "SVC*HC:Q5001*1000.00*1000.00*0651*7",
  ],
  // zero-dollar remit paid by ACH (BPR04 not NON): accepted today, the companion guide may require NON.
  "06-zero-payment-ach": [
    bpr("0.00"),
    ...hdr("EFT1006", "SYNTHETIC MAC"),
    "CLP*PCN-6001*4*600.00*0.00*0.00*MA*ICN-6001*813",
    "NM1*QC*1*POE*PAT****MI*3CC3CC3CC33",
    "CAS*CO*18*600.00",
  ],
  // payee identified by tax id (N103=FI) with REF*TJ and the PTAN in REF*PQ; no NPI.
  "07-payee-tax-id-and-ptan": [
    bpr("1500.00"),
    ...hdr("EFT1007", "SYNTHETIC MAC", "20260616", "N1*PE*SYNTH HOSPICE*FI*123456789"),
    "REF*TJ*123456789",
    "REF*PQ*PTAN0001",
    "CLP*PCN-7001*1*1500.00*1500.00*0.00*MA*ICN-7001*813",
    "NM1*QC*1*DOE*JANE****MI*1AA1AA1AA11",
    "SVC*HC:Q5001*1500.00*1500.00*0651*10",
  ],
};

/** The 835 text of every sample, keyed by file stem (segments one per line). */
export const SAMPLES: Record<string, string> = Object.fromEntries(
  Object.entries(bodies).map(([name, body]) => [name, wrap835(body).replaceAll("~", "~\n")]),
);

// 08: two transaction sets (ST02 0001 and 0002) in one interchange, each balanced on its own.
const setA = [
  bpr("500.00"),
  ...hdr("EFT1008A", "SYNTHETIC MAC"),
  "CLP*PCN-8001*1*500.00*500.00*0.00*MA*ICN-8001*813",
  "NM1*QC*1*DOE*JANE****MI*1AA1AA1AA11",
];
const setB = [
  bpr("250.00"),
  ...hdr("EFT1008B", "SYNTHETIC MAC"),
  "CLP*PCN-8002*1*250.00*250.00*0.00*MA*ICN-8002*813",
  "NM1*QC*1*ROE*RICHARD****MI*2BB2BB2BB22",
];
SAMPLES["08-two-transaction-sets"] = wrap835Sets([
  ["0001", setA],
  ["0002", setB],
]).replaceAll("~", "~\n");

if (process.argv[1]?.endsWith("generate.ts")) {
  for (const [name, text] of Object.entries(SAMPLES)) {
    writeFileSync(new URL(`./${name}.835`, import.meta.url), text);
    console.log("wrote", name);
  }
}
