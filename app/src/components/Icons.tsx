import type { ReactNode } from 'react';

/** Monochrome line icons: they take their colour from the surrounding text (currentColor). */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="tab-icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const BooksIcon = () => (
  <Icon>
    <path d="M12 6.5C10.3 5.3 8 4.8 4.5 5v13c3.5-.2 5.8.3 7.5 1.5 1.7-1.2 4-1.7 7.5-1.5V5C16 4.8 13.7 5.3 12 6.5Z" />
    <path d="M12 6.5v13" />
  </Icon>
);

export const CardIcon = () => (
  <Icon>
    <rect x="3" y="5.5" width="18" height="13" rx="3" />
    <path d="M3 10h18M7 15h3" />
  </Icon>
);

export const BellIcon = () => (
  <Icon>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15L6 16.5Z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Icon>
);

export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.8 7.3 7 9 4.2-1.7 7-4.8 7-9V6l-7-2.5Z" />
    <path d="m9 12 2.2 2.2L15.2 10" />
  </Icon>
);

/** Small inline glyphs for controls (chevrons, checkmarks). */
function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export const ChevronDownIcon = ({ className }: { className?: string }) => (
  <Glyph className={className} d="m6 9 6 6 6-6" />
);
export const ChevronLeftIcon = ({ className }: { className?: string }) => (
  <Glyph className={className} d="m15 6-6 6 6 6" />
);
export const ChevronRightIcon = ({ className }: { className?: string }) => (
  <Glyph className={className} d="m9 6 6 6-6 6" />
);
export const CheckIcon = ({ className }: { className?: string }) => (
  <Glyph className={className} d="m5 12.5 4.5 4.5L19 7.5" />
);
