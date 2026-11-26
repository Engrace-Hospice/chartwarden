/**
 * Replaces a jsdom accessor on HTMLImageElement.prototype and returns a function that restores the
 * original accessor (a `finally` that only deleted the property would remove jsdom's own).
 */
export function overrideImageProperty(
  name: "complete" | "naturalWidth",
  value: unknown,
): () => void {
  const proto = HTMLImageElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, name);
  Object.defineProperty(proto, name, { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(proto, name, original);
    else Reflect.deleteProperty(proto, name);
  };
}
