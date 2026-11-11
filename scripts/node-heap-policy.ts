const DEFAULT_HEAP_OPTION = "--max-old-space-size=6144";
const HEAP_LIMIT = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=\d+|\s+\d+)(?:\s|$)/;

/** Preserve caller options while guaranteeing that every Node child has a bounded heap. */
export function resolveBoundedNodeOptions(
  env: Readonly<Record<string, string | undefined>>,
  overrideKey?: string,
): string {
  const override = overrideKey ? env[overrideKey]?.trim() : undefined;
  const inherited = env.NODE_OPTIONS?.trim();
  const options = override || inherited;
  if (!options) return DEFAULT_HEAP_OPTION;
  return HEAP_LIMIT.test(options) ? options : `${options} ${DEFAULT_HEAP_OPTION}`;
}
