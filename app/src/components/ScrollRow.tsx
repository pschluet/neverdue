import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';

/** Width of the faded edge (matches --fade-* in styles.css). */
const EDGE = 56;

/**
 * A horizontally scrolling row (e.g. filter chips) with no visible scrollbar. When items are hidden
 * past an edge, that edge fades out and a small arrow appears, so it's obvious there's more.
 * `activeKey` should change whenever the selected item changes; that item (the child with the
 * `active` class) is then scrolled into view.
 */
export function ScrollRow({
  label,
  activeKey,
  children,
}: {
  label: string;
  activeKey?: unknown;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setMore((m) => (m.start === start && m.end === end ? m : { start, end }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [measure, children]);

  // Scroll the row (only the row, never the page) to an exact, clamped position. Explicit
  // targets avoid iOS Safari overshooting on relative smooth scrolls.
  const scrollTo = (left: number) => {
    const el = ref.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    el.scrollTo?.({ left: Math.max(0, Math.min(max, Math.round(left))), behavior: 'smooth' });
  };

  // Keep the selected chip clear of the faded edges.
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('.active');
    if (!el || !active) return;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < el.scrollLeft + EDGE) scrollTo(left - EDGE);
    else if (right > el.scrollLeft + el.clientWidth - EDGE) scrollTo(right - el.clientWidth + EDGE);
  }, [activeKey]);

  // Arrows page to the chip that's cut off on that side, bringing it to the opposite edge.
  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const chips = Array.from(el.children) as HTMLElement[];
    if (dir === 1) {
      const edge = el.scrollLeft + el.clientWidth - EDGE;
      const next = chips.find((c) => c.offsetLeft + c.offsetWidth > edge + 1);
      if (next) scrollTo(next.offsetLeft - EDGE);
    } else {
      const edge = el.scrollLeft + EDGE;
      const prev = chips.filter((c) => c.offsetLeft < edge - 1).pop();
      if (prev) scrollTo(prev.offsetLeft + prev.offsetWidth - el.clientWidth + EDGE);
    }
  };

  return (
    <div
      className="scroll-row"
      data-more-start={more.start || undefined}
      data-more-end={more.end || undefined}
    >
      <div ref={ref} className="chips" role="group" aria-label={label} onScroll={measure}>
        {children}
      </div>
      <button
        type="button"
        className="scroll-arrow start"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => page(-1)}
      >
        <ChevronLeftIcon />
      </button>
      <button
        type="button"
        className="scroll-arrow end"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => page(1)}
      >
        <ChevronRightIcon />
      </button>
    </div>
  );
}
