// M12 GAP-036 follow-up — the drug-allergy knowledge the allergy gate matches against. DATA ONLY: no logic.
//
// Scope is the formulary a hospice actually orders (comfort kit, symptom control, common antibiotics and
// chronic meds). Adding a drug or class is a data edit here plus a case in the matcher test. This is a
// clinical-content table: it is deliberately conservative (an over-match costs a documented
// acknowledgement; an under-match hides an allergy), and every cross-reactivity edge below is stated.
//
// All keys are lower-case, punctuation-free, single-spaced (the matcher normalizes input the same way).

export interface DrugClassDef {
  /** Non-PHI wording used in error text and audit payloads. */
  readonly label: string;
  /** Generic names that belong to this class. */
  readonly members: readonly string[];
  /** Words a clinician writes when the allergy is to the whole class. */
  readonly aliases: readonly string[];
  /** Broader classes this one rolls up into (e.g. penicillin -> beta lactam). */
  readonly parents?: readonly string[];
  /**
   * True when an allergy recorded against ONE member is clinically a reason to stop for the WHOLE class
   * (NSAID COX-1 cross-sensitivity). False for classes where rotating within the class is routine
   * (opioids: a morphine allergy must not block fentanyl) or the "allergy" is usually intolerance (statins).
   */
  readonly memberAllergyBlocksClass?: boolean;
}

export const DRUG_CLASSES: Readonly<Record<string, DrugClassDef>> = {
  opioid: {
    label: "opioid",
    members: [
      "morphine",
      "hydromorphone",
      "oxycodone",
      "oxymorphone",
      "hydrocodone",
      "fentanyl",
      "sufentanil",
      "methadone",
      "codeine",
      "tramadol",
      "tapentadol",
      "meperidine",
      "buprenorphine",
      "levorphanol",
    ],
    aliases: ["opioid", "opioids", "opiate", "opiates", "narcotic", "narcotics"],
  },
  penicillin: {
    label: "penicillin",
    members: [
      "penicillin",
      "amoxicillin",
      "ampicillin",
      "piperacillin",
      "nafcillin",
      "oxacillin",
      "dicloxacillin",
      "ticarcillin",
      "clavulanate",
    ],
    aliases: ["penicillin", "penicillins", "pcn", "penicillin class"],
    parents: ["beta_lactam"],
  },
  cephalosporin: {
    label: "cephalosporin",
    members: [
      "cephalexin",
      "cefazolin",
      "cefadroxil",
      "cefuroxime",
      "cefoxitin",
      "cefdinir",
      "cefpodoxime",
      "ceftriaxone",
      "ceftazidime",
      "cefepime",
    ],
    aliases: ["cephalosporin", "cephalosporins", "cef", "ceph"],
    parents: ["beta_lactam"],
  },
  carbapenem: {
    label: "carbapenem",
    members: ["meropenem", "imipenem", "ertapenem", "doripenem"],
    aliases: ["carbapenem", "carbapenems"],
    parents: ["beta_lactam"],
  },
  beta_lactam: {
    label: "beta-lactam antibiotic",
    members: ["aztreonam"],
    aliases: [
      "beta lactam",
      "beta lactams",
      "betalactam",
      "betalactams",
      "beta lactam antibiotic",
      "beta lactam antibiotics",
    ],
  },
  sulfonamide_antibiotic: {
    label: "sulfonamide antibiotic",
    members: ["sulfamethoxazole", "sulfadiazine", "sulfasalazine", "sulfisoxazole"],
    aliases: [
      "sulfa",
      "sulfa drug",
      "sulfa drugs",
      "sulfonamide",
      "sulfonamides",
      "sulfonamide antibiotic",
      "sulfonamide antibiotics",
    ],
  },
  nsaid: {
    label: "NSAID",
    members: [
      "ibuprofen",
      "naproxen",
      "ketorolac",
      "diclofenac",
      "meloxicam",
      "celecoxib",
      "indomethacin",
      "etodolac",
      "nabumetone",
      "ketoprofen",
      "aspirin",
    ],
    aliases: [
      "nsaid",
      "nsaids",
      "nonsteroidal",
      "nonsteroidal anti inflammatory",
      "anti inflammatory",
      "anti inflammatories",
    ],
    memberAllergyBlocksClass: true,
  },
  statin: {
    label: "statin",
    members: [
      "atorvastatin",
      "simvastatin",
      "rosuvastatin",
      "pravastatin",
      "lovastatin",
      "fluvastatin",
      "pitavastatin",
    ],
    aliases: ["statin", "statins", "hmg coa reductase inhibitor", "hmg coa reductase inhibitors"],
  },
  benzodiazepine: {
    label: "benzodiazepine",
    members: [
      "lorazepam",
      "midazolam",
      "diazepam",
      "clonazepam",
      "alprazolam",
      "temazepam",
      "oxazepam",
      "chlordiazepoxide",
      "clobazam",
    ],
    aliases: ["benzodiazepine", "benzodiazepines", "benzo", "benzos"],
  },
  phenothiazine: {
    label: "phenothiazine",
    members: ["chlorpromazine", "promethazine", "prochlorperazine", "perphenazine", "fluphenazine"],
    aliases: ["phenothiazine", "phenothiazines"],
  },
  serotonin_antagonist_antiemetic: {
    label: "5-HT3 antagonist antiemetic",
    members: ["ondansetron", "granisetron", "palonosetron"],
    aliases: ["5 ht3 antagonist", "5 ht3 antagonists", "setron", "setrons"],
  },
  corticosteroid: {
    label: "corticosteroid",
    members: [
      "dexamethasone",
      "prednisone",
      "prednisolone",
      "methylprednisolone",
      "hydrocortisone",
      "budesonide",
    ],
    aliases: ["corticosteroid", "corticosteroids", "steroid", "steroids", "glucocorticoid"],
  },
  fluoroquinolone: {
    label: "fluoroquinolone",
    members: ["ciprofloxacin", "levofloxacin", "moxifloxacin", "ofloxacin"],
    aliases: ["fluoroquinolone", "fluoroquinolones", "quinolone", "quinolones"],
  },
  macrolide: {
    label: "macrolide",
    members: ["azithromycin", "erythromycin", "clarithromycin"],
    aliases: ["macrolide", "macrolides"],
  },
  tetracycline: {
    label: "tetracycline",
    members: ["doxycycline", "minocycline", "tetracycline"],
    aliases: ["tetracycline", "tetracyclines"],
  },
};

/**
 * Documented cross-reactivity between classes (an allergy in the KEY class also flags the VALUE classes).
 * The M12 spec states none, so this is the conservative clinical set: penicillin <-> cephalosporin
 * (shared beta-lactam ring; low but real cross-sensitivity). Flagged matches still resolve through the
 * same acknowledgement, they are never a hard stop.
 */
export const CLASS_CROSS_REACTIVITY: Readonly<Record<string, readonly string[]>> = {
  penicillin: ["cephalosporin"],
  cephalosporin: ["penicillin"],
};

/** Generics that are not a class member but still need a stable identity (no class, direct match only). */
export const OTHER_GENERICS: readonly string[] = [
  "haloperidol",
  "acetaminophen",
  "metoclopramide",
  "glycopyrrolate",
  "scopolamine",
  "hyoscyamine",
  "atropine",
  "furosemide",
  "quetiapine",
  "olanzapine",
  "risperidone",
  "levetiracetam",
  "phenobarbital",
  "gabapentin",
  "pregabalin",
  "mirtazapine",
  "diphenhydramine",
  "hydroxyzine",
  "senna",
  "bisacodyl",
  "lactulose",
  "polyethylene glycol",
  "metronidazole",
  "clindamycin",
  "vancomycin",
  "nystatin",
  "fluconazole",
  "baclofen",
  "dexmedetomidine",
  "ketamine",
  "lidocaine",
  "octreotide",
  "megestrol",
  "trazodone",
  "sertraline",
  "duloxetine",
  "amitriptyline",
  "nortriptyline",
  "oxybutynin",
  "tamsulosin",
  "famotidine",
  "omeprazole",
  "pantoprazole",
  "docusate",
];

/** Brand (or abbreviation) -> generic(s) a hospice commonly orders. Combination products list every ingredient. */
export const BRAND_TO_GENERICS: Readonly<Record<string, readonly string[]>> = {
  "ms contin": ["morphine"],
  roxanol: ["morphine"],
  msir: ["morphine"],
  kadian: ["morphine"],
  avinza: ["morphine"],
  dilaudid: ["hydromorphone"],
  exalgo: ["hydromorphone"],
  oxycontin: ["oxycodone"],
  roxicodone: ["oxycodone"],
  oxyir: ["oxycodone"],
  percocet: ["oxycodone", "acetaminophen"],
  endocet: ["oxycodone", "acetaminophen"],
  norco: ["hydrocodone", "acetaminophen"],
  vicodin: ["hydrocodone", "acetaminophen"],
  lortab: ["hydrocodone", "acetaminophen"],
  duragesic: ["fentanyl"],
  actiq: ["fentanyl"],
  dolophine: ["methadone"],
  methadose: ["methadone"],
  ultram: ["tramadol"],
  nucynta: ["tapentadol"],
  demerol: ["meperidine"],
  subutex: ["buprenorphine"],
  suboxone: ["buprenorphine"],
  haldol: ["haloperidol"],
  ativan: ["lorazepam"],
  versed: ["midazolam"],
  valium: ["diazepam"],
  klonopin: ["clonazepam"],
  xanax: ["alprazolam"],
  zofran: ["ondansetron"],
  tylenol: ["acetaminophen"],
  apap: ["acetaminophen"],
  advil: ["ibuprofen"],
  motrin: ["ibuprofen"],
  aleve: ["naproxen"],
  toradol: ["ketorolac"],
  voltaren: ["diclofenac"],
  mobic: ["meloxicam"],
  celebrex: ["celecoxib"],
  decadron: ["dexamethasone"],
  deltasone: ["prednisone"],
  medrol: ["methylprednisolone"],
  reglan: ["metoclopramide"],
  phenergan: ["promethazine"],
  compazine: ["prochlorperazine"],
  thorazine: ["chlorpromazine"],
  robinul: ["glycopyrrolate"],
  transderm: ["scopolamine"],
  levsin: ["hyoscyamine"],
  lasix: ["furosemide"],
  seroquel: ["quetiapine"],
  zyprexa: ["olanzapine"],
  risperdal: ["risperidone"],
  keppra: ["levetiracetam"],
  neurontin: ["gabapentin"],
  lyrica: ["pregabalin"],
  remeron: ["mirtazapine"],
  benadryl: ["diphenhydramine"],
  atarax: ["hydroxyzine"],
  lipitor: ["atorvastatin"],
  zocor: ["simvastatin"],
  crestor: ["rosuvastatin"],
  pravachol: ["pravastatin"],
  bactrim: ["sulfamethoxazole"],
  septra: ["sulfamethoxazole"],
  "pen vk": ["penicillin"],
  amoxil: ["amoxicillin"],
  augmentin: ["amoxicillin", "clavulanate"],
  zosyn: ["piperacillin"],
  keflex: ["cephalexin"],
  ancef: ["cefazolin"],
  rocephin: ["ceftriaxone"],
  omnicef: ["cefdinir"],
  cipro: ["ciprofloxacin"],
  levaquin: ["levofloxacin"],
  zithromax: ["azithromycin"],
  flagyl: ["metronidazole"],
  cleocin: ["clindamycin"],
  vibramycin: ["doxycycline"],
  ditropan: ["oxybutynin"],
  pepcid: ["famotidine"],
  prilosec: ["omeprazole"],
  protonix: ["pantoprazole"],
};
