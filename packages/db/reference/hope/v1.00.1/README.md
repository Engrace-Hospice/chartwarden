# CMS HOPE Data Specifications v1.00.1

Source: CMS HOPE Data Specifications CSV package.

Data Specifications version: `1.00.1`

Item Set: `1.00`

Publication: `FINAL 04-04-2025`

Effective: `2025-10-01`

The CSV files in this directory are retained as regulatory reference source material for the M10 HOPE
modernization importer. They are copied unchanged from the official package named
`HOPE Data Spec CSV Files (V1.00.1) FINAL 04-04-2025`.

Table mapping:

- `itm_mstr*.csv` populates `hope_spec_item`.
- `itm_mstr*.csv` ISC columns (`isc_ha`, `isc_huv`, `isc_hd`, `isc_xx`) populate `hope_spec_item_isc`.
- `itm_val*.csv` populates `hope_spec_item_option`.
- `isc_mstr*.csv` and `isc_val*.csv` are retained for provenance and importer validation of known ISC codes.
- `rltn_mstr*.csv`, `rltn_itms*.csv`, and `rltn_itm_txt*.csv` are retained for the future CMS validation/rule engine, but Phase 1B does not import them into database tables.

Runtime answer semantics remain separate from reference serialization metadata: CMS `^` is represented in
`hope_assessment_answer` as `state = skipped` and `value = null`, not as a normal answer value.

Known source note:

- `isc_val` carries the record-classifier metadata for ISC values and lists `HA` with `A0250_val = 0`.
  The item value table (`itm_val`) and rule text (`rltn_mstr` / `rltn_itm_txt`) identify Admission as
  `A0250 = 1`. Phase 1B preserves the source files unchanged and does not implement runtime
  record-classifier mapping; that belongs to a later assessment/submission phase.
