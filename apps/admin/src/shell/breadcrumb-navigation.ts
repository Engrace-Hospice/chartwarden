import type { BreadcrumbItem } from "@chartwarden/ui";
import { generatePath, matchPath } from "react-router-dom";
import type { AdminNavSection } from "./admin-nav";
import type { AdminScreenDescriptor } from "./registry";

const PARENTS: Readonly<Record<string, string>> = {
  "/admin/refunds/new": "/admin/refunds",
  "/admin/refunds/:id/approve": "/admin/refunds",
  "/admin/usage/:organizationId": "/admin/subscriptions",
};

function depth(path: string): number {
  return path.split("/").filter(Boolean).length;
}
function hrefFor(pattern: string, pathname: string): string | undefined {
  const match = matchPath({ path: pattern, end: false }, pathname);
  if (!match) return pattern.includes(":") ? undefined : pattern;
  try {
    return generatePath(pattern, match.params);
  } catch {
    return undefined;
  }
}

export function resolveAdminBreadcrumbs(
  pathname: string,
  screens: readonly AdminScreenDescriptor[],
  sections: readonly AdminNavSection[],
): BreadcrumbItem[] {
  if (pathname === "/") return [{ label: "Overview" }];
  const current = screens
    .filter((screen) => matchPath({ path: screen.path, end: true }, pathname))
    .sort(
      (a, b) =>
        depth(b.path) - depth(a.path) ||
        b.path.replace(/:[^/]+/g, "").length - a.path.replace(/:[^/]+/g, "").length,
    )[0];
  if (!current) return [];
  const chain = [current];
  const seen = new Set([current.path]);
  while (true) {
    const route = chain[0]!;
    const parentPattern = PARENTS[route.path];
    const parent = parentPattern
      ? screens.find((screen) => screen.path === parentPattern)
      : screens
          .filter(
            (screen) =>
              depth(screen.path) < depth(route.path) &&
              matchPath({ path: screen.path, end: false }, pathname),
          )
          .sort((a, b) => depth(b.path) - depth(a.path))[0];
    if (!parent || seen.has(parent.path)) break;
    chain.unshift(parent);
    seen.add(parent.path);
  }
  const owner =
    sections
      .flatMap((section) => section.entries.map((entry) => ({ section, entry })))
      .filter(
        ({ entry }) =>
          entry.to === pathname || (entry.to !== "/" && pathname.startsWith(`${entry.to}/`)),
      )
      .sort((a, b) => b.entry.to.length - a.entry.to.length)[0] ??
    sections
      .flatMap((section) => section.entries.map((entry) => ({ section, entry })))
      .find(({ entry }) => entry.to === chain[0]?.path);
  const items: BreadcrumbItem[] = [];
  if (owner) {
    const first = owner.section.entries[0];
    if (owner.section.label && first)
      items.push({
        label: owner.section.label,
        href: first.to === pathname ? undefined : first.to,
      });
    if (owner.entry.label !== items.at(-1)?.label)
      items.push({
        label: owner.entry.label,
        href: owner.entry.to === pathname ? undefined : owner.entry.to,
      });
  }
  for (const route of chain) {
    const href = hrefFor(route.path, pathname);
    if (href !== items.at(-1)?.href) items.push({ label: route.title, href });
  }
  if (items.length) items[items.length - 1] = { label: items[items.length - 1]!.label };
  return items;
}
