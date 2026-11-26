import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from './Icons';

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

  useEffect(() => {
    const active = ref.current?.querySelector<HTMLElement>('.active');
    active?.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [activeKey]);

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' });
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
