import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CheckIcon, ChevronDownIcon } from './Icons';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
}

/** Room kept clear at the bottom of the viewport for the floating tab bar. */
const BOTTOM_RESERVE = 110;
const MAX_LIST_HEIGHT = 280;

/**
 * A glass-styled dropdown replacing the native <select>. It follows the WAI-ARIA "select-only
 * combobox" pattern: focus stays on the trigger, and the highlighted option is tracked with
 * aria-activedescendant.
 */
export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ text: '', timer: 0 });

  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const [active, setActive] = useState(selectedIndex);
  const current = options.find((o) => o.value === value);

  const show = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const wanted = Math.min(MAX_LIST_HEIGHT, options.length * 44 + 12);
      const below = window.innerHeight - BOTTOM_RESERVE - rect.bottom;
      setAbove(below < wanted && rect.top > below);
    }
    setActive(selectedIndex);
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (o && o.value !== value) onChange(o.value);
    hide();
  };

  // Close when tapping anywhere else.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) hide(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Keep the highlighted option visible (on open this is the selected one).
  useLayoutEffect(() => {
    if (!open) return;
    const el = document.getElementById(`${id}-opt-${active}`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active, id]);

  const onKeyDown = (e: KeyboardEvent) => {
    const last = options.length - 1;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(last, a + 1));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        return;
      case 'Home':
        e.preventDefault();
        setActive(0);
        return;
      case 'End':
        e.preventDefault();
        setActive(last);
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(active);
        return;
      case 'Escape':
        e.preventDefault();
        hide();
        return;
      case 'Tab':
        hide(false);
        return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const t = typeahead.current;
      window.clearTimeout(t.timer);
      t.text += e.key.toLowerCase();
      t.timer = window.setTimeout(() => (t.text = ''), 600);
      const i = options.findIndex((o) => o.label.toLowerCase().startsWith(t.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div className="field" ref={rootRef}>
      <span className="field-label" id={labelId} onClick={() => triggerRef.current?.focus()}>
        {label}
      </span>
      <div className="select">
        <div
          ref={triggerRef}
          className="select-trigger"
          role="combobox"
          tabIndex={0}
          aria-labelledby={labelId}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? optionId(active) : undefined}
          onClick={() => (open ? hide() : show())}
          onKeyDown={onKeyDown}
        >
          <span className="select-value">{current?.label ?? ''}</span>
          <ChevronDownIcon className="select-chevron" />
        </div>
        {open && (
          <ul
            ref={listRef}
            id={listId}
            className={above ? 'select-list above' : 'select-list'}
            role="listbox"
            aria-labelledby={labelId}
            // Keep focus on the trigger while tapping an option.
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <li
                key={String(o.value)}
                id={optionId(i)}
                role="option"
                aria-selected={o.value === value}
                className={i === active ? 'select-option active' : 'select-option'}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
              >
                <span>{o.label}</span>
                {o.value === value && <CheckIcon className="select-check" />}
              </li>
            ))}
          </ul>
        )}
      </div>
      {hint && <span className="muted small-text select-hint">{hint}</span>}
    </div>
  );
}
