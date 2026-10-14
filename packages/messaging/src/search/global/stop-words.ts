// ADR-0058 decision 3: the 101-word English stop list. Negations and clinical words (not, none, never, without, pain,
// off, above, below) are deliberately NOT here; mg/ms/ml/iv/no are under the 3-character minimum and need no entry.
export const STOP_WORDS: ReadonlySet<string> = new Set(
  `about after again against all also and any are because been before being between both but can could does doing down
during each else even ever for from further get got had has have her here him his how into its just let like made make
many may might more most much must once only other our out over own same she should some such than that the their them
then there these they this those through too under until upon use very via was were what when where which while who whom
why will with would yet you your yours`.split(/\s+/),
);
