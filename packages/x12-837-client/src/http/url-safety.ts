/** Parse a configured vendor API root without accepting credentials or URL components that can smuggle destinations. */
export function parseSafeHttpsBaseUrl(raw: string, envName: string): URL {
  let url: URL;
  try {
    if (raw.includes("\\")) throw new Error("backslash in URL");
    url = new URL(raw);
  } catch {
    throw new Error(`${envName} is not a usable URL`);
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${envName} must be an https URL without credentials, query or fragment`);
  }
  return url;
}

/** Resolve a documented relative wire path without allowing origin, root, query or fragment changes. */
export function resolveSafeRelativePath(base: URL, path: string): URL | null {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[?#]/.test(path) ||
    /^[a-z][a-z\d+.-]*:/i.test(path) ||
    path.split("/").some((part) => part === "." || part === "..") ||
    /%(?:2e|2f|5c)/i.test(path)
  ) {
    return null;
  }
  try {
    const root = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
    const target = new URL(path, root);
    if (
      target.origin !== root.origin ||
      !target.pathname.startsWith(root.pathname) ||
      target.search !== "" ||
      target.hash !== "" ||
      target.username !== "" ||
      target.password !== ""
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}
