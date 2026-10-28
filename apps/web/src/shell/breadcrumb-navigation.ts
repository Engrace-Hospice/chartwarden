import type { BreadcrumbItem } from "@chartwarden/ui";
import { generatePath, matchPath } from "react-router-dom";
import type { NavEntry, NavSection } from "./primary-nav";
import type { WebScreenDescriptor } from "./screen-registry";

// A few workflows leave the URL prefix of their real list/queue. Keep those relationships
// explicit; all other descendants inherit their nearest registered route ancestor.
const PARENTS: Readonly<Record<string, string>> = {
  "/discharges/:id/cosign": "/admissions/discharges",
  "/intake/:batchId/review": "/intake/:batchId",
  "/admissions/:id/readmit": "/admissions/readmit",
  "/admissions/:id/discharge": "/admissions/:id",
  "/referrals/new": "/referrals",
  "/referrals/:id": "/referrals",
};

const LABELS: Readonly<Record<string, string>> = {
  "/admissions/new": "Direct intake",
  "/admissions": "All admissions",
};

function specificity(path: string): number {
  return path
    .split("/")
    .filter(Boolean)
    .reduce((score, segment) => score + (segment.startsWith(":") ? 1 : 10), 0);
}

function matchedScreen(
  screens: readonly WebScreenDescriptor[],
  pathname: string,
): WebScreenDescriptor | undefined {
  return screens
    .filter((screen) => matchPath({ path: screen.path, end: true }, pathname))
    .sort((a, b) => specificity(b.path) - specificity(a.path))[0];
}

function routeHref(pattern: string, pathname: string): string | undefined {
  const match = matchPath({ path: pattern, end: false }, pathname);
  if (!match) return pattern.includes(":") ? undefined : pattern;
  try {
    return generatePath(pattern, match.params);
  } catch {
    return undefined;
  }
}

function parentOf(
  route: WebScreenDescriptor,
  pathname: string,
  screens: readonly WebScreenDescriptor[],
): WebScreenDescriptor | undefined {
  const explicit = PARENTS[route.path];
  if (explicit) return screens.find((screen) => screen.path === explicit);
  const depth = route.path.split("/").filter(Boolean).length;
  return screens
    .filter((screen) => screen.path !== "/" && screen.path !== route.path)
    .filter((screen) => screen.path.split("/").filter(Boolean).length < depth)
    .filter((screen) => matchPath({ path: screen.path, end: false }, pathname))
    .sort(
      (a, b) =>
        b.path.split("/").length - a.path.split("/").length ||
        specificity(b.path) - specificity(a.path),
    )[0];
}

function ownerOf(
  sections: readonly NavSection[],
  chain: readonly WebScreenDescriptor[],
  pathname: string,
): NavEntry | undefined {
  const entries = sections.flatMap((section) => section.entries);
  // The visible screen's explicit sidebar ownership beats a coincidental URL prefix.
  return (
    entries.find((entry) => entry.screens.some((screen) => screen.path === chain.at(-1)?.path)) ??
    entries.find((entry) =>
      entry.screens.some((screen) => chain.some((route) => route.path === screen.path)),
    ) ??
    entries
      .filter((entry) =>
        entry.matchPrefixes.some(
          (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
        ),
      )
      .sort(
        (a, b) =>
          Math.max(
            ...b.matchPrefixes.filter((p) => pathname.startsWith(p)).map((p) => p.length),
            0,
          ) -
          Math.max(
            ...a.matchPrefixes.filter((p) => pathname.startsWith(p)).map((p) => p.length),
            0,
          ),
      )[0]
  );
}

/** Breadcrumb hierarchy from the registered route corpus and the actor-visible sidebar. */
export function resolveBreadcrumbs(
  pathname: string,
  screens: readonly WebScreenDescriptor[],
  sections: readonly NavSection[],
  visibleScreens: readonly WebScreenDescriptor[] = screens,
): BreadcrumbItem[] {
  if (pathname === "/") return [{ label: "Home" }];
  const current = matchedScreen(screens, pathname);
  if (!current) return [];

  const chain: WebScreenDescriptor[] = [current];
  const seen = new Set([current.path]);
  let cursor = current;
  while (true) {
    const parent = parentOf(cursor, pathname, screens);
    if (!parent || seen.has(parent.path)) break;
    chain.unshift(parent);
    seen.add(parent.path);
    cursor = parent;
  }

  const owner = ownerOf(sections, chain, pathname);
  const visiblePaths = new Set(visibleScreens.map((screen) => screen.path));
  const first = chain[0];
  const items: BreadcrumbItem[] = [];
  if (owner && owner.key !== "home") {
    items.push({
      label: owner.label,
      href: owner.href === pathname ? undefined : (owner.href ?? undefined),
    });
    const sub = owner.subsections?.find((candidate) =>
      candidate.screens.some((screen) => chain.some((route) => route.path === screen.path)),
    );
    if (sub) {
      const landing = sub.screens[0];
      if (landing) items.push({ label: sub.label, href: landing.path });
    }
  }
  for (const route of chain) {
    const href = routeHref(route.path, pathname);
    if (route === current && owner?.href === pathname && items.at(-1)?.label === route.title)
      continue;
    // A landing page already represented by the primary item should appear only once.
    if (items.at(-1)?.href === href && route === first && route === current) {
      items[items.length - 1] = { label: items.at(-1)!.label };
    } else if (items.at(-1)?.href !== href) {
      items.push({
        label: LABELS[route.path] ?? route.title,
        href: visiblePaths.has(route.path) ? href : undefined,
      });
    }
  }
  if (items.length > 0) items[items.length - 1] = { label: items[items.length - 1]!.label };
  return items;
}
