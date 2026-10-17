// The Chawo mark and logo, as zai-brand draws them (components/brand/ChawoLogo.jsx): a capital C
// of bars, exactly one coral. Taken as is, never redrawn; there is no single-colour version.
// The app is dark only, so these are the dark-theme inks: --peach-cream bars, --coral-red accent.

const INK = '#FFF3E2'; // --peach-cream
const ACCENT = '#EF5143'; // --coral-red

const FULL = [
  { x: 14, y: 0, w: 78 },
  { x: 2, y: 20, w: 34 },
  { x: 0, y: 40, w: 26 },
  { x: 2, y: 60, w: 34, accent: true },
  { x: 14, y: 80, w: 78 },
];
const SMALL = [
  { x: 5, y: 1, w: 26 },
  { x: 1, y: 9, w: 11 },
  { x: 1, y: 17, w: 13, accent: true },
  { x: 5, y: 25, w: 26 },
];

/** The mark alone (rail, avatar). size ≤ 40 takes the four-bar tier, as in the brand component. */
export function ChawoMark({ size = 24, label = 'Chawo' }: { size?: number; label?: string }) {
  const small = size <= 40;
  const bars = small ? SMALL : FULL;
  const vb = small ? 32 : 96;
  const h = small ? 6 : 16;
  return (
    <svg
      viewBox={`0 0 ${vb} ${vb}`}
      width={size}
      height={size}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      style={{ display: 'block', flex: 'none' }}
    >
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={b.w} height={h} rx={h / 2} fill={'accent' in b ? ACCENT : INK} />
      ))}
    </svg>
  );
}

/** The logo: the mark in place of the capital C, then «hawo» set in DIN Pro 800. */
export function ChawoLogo({ fontSize = 22 }: { fontSize?: number }) {
  return (
    <span
      role="img"
      aria-label="Chawo"
      style={{ display: 'inline-flex', alignItems: 'baseline', fontWeight: 800, fontSize, lineHeight: 1, letterSpacing: '-0.025em', color: INK, whiteSpace: 'nowrap' }}
    >
      <span style={{ display: 'inline-block', marginRight: '-0.0156em', alignSelf: 'center' }} aria-hidden="true">
        <ChawoMark size={Math.round(fontSize * 0.771)} label="" />
      </span>
      <span aria-hidden="true">hawo</span>
    </span>
  );
}
