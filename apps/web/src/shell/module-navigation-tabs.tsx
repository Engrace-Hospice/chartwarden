import { type JSX, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { resolveModuleNavigation } from "./module-navigation";
import type { NavSection } from "./primary-nav";

export interface ModuleNavigationTabsProps {
  sections: NavSection[];
  pathname: string;
}

/** Route navigation, not an in-page tab panel: links + aria-current are the accessible semantics. */
export function ModuleNavigationTabs({
  sections,
  pathname,
}: ModuleNavigationTabsProps): JSX.Element | null {
  const navigation = useMemo(
    () => resolveModuleNavigation(sections, pathname),
    [sections, pathname],
  );
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activePath = navigation?.activePath;

  useEffect(() => {
    if (!activePath) return;
    const scroller = scrollerRef.current;
    const current = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!scroller || !current) return;
    const left = current.offsetLeft;
    const right = left + current.offsetWidth;
    if (left < scroller.scrollLeft) scroller.scrollTo({ left, behavior: "smooth" });
    else if (right > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollTo({ left: right - scroller.clientWidth, behavior: "smooth" });
    }
  }, [activePath]);

  if (!navigation) return null;
  return (
    <div className="wx-module-tabs-frame">
      <nav className="wx-module-tabs" aria-label={`${navigation.label} pages`}>
        <div ref={scrollerRef} className="wx-module-tabs-scroll wx-no-scrollbar">
          {navigation.items.map((item) => {
            const active = navigation.activePath === item.path;
            return (
              <Link
                key={item.id}
                to={item.path}
                className={active ? "wx-module-tab active" : "wx-module-tab"}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
