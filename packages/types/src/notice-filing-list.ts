// @chartwarden/types — the one number the platform's list of "filed outside ChartWarden" notices is cut at. The M23 list function cuts at it,
// the OpenAPI text and the operator's drawer both say it, so the three can never drift (a drawer that says 200 over a server that cuts at
// 100 would hide records the operator is told are shown).
export const EXTERNAL_NOTICE_FILING_LIST_CAP = 200;
