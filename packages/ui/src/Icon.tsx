// Product UI icons (ZAI Product UI Core): Lucide 0.577.0 outlines, the same symbols as the zai-brand
// sprite (assets/product-ui-icons.svg). Sizes 16/20/24, stroke 1.75, colour from the text. Decorative
// next to a label; an icon-only control gets its name from aria-label on the control.
import type { SVGProps } from 'react';

type Shape = ['path' | 'rect' | 'circle' | 'line' | 'polyline', Record<string, string>];

const ICONS = {
  'mic': [['path', { d: "M12 19v3" }], ['path', { d: "M19 10v2a7 7 0 0 1-14 0v-2" }], ['rect', { x: "9", y: "2", width: "6", height: "13", rx: "3" }]],
  'file-audio': [['path', { d: "M4 6.835V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.706.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2h-.343" }], ['path', { d: "M14 2v5a1 1 0 0 0 1 1h5" }], ['path', { d: "M2 19a2 2 0 0 1 4 0v1a2 2 0 0 1-4 0v-4a6 6 0 0 1 12 0v4a2 2 0 0 1-4 0v-1a2 2 0 0 1 4 0" }]],
  'history': [['path', { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }], ['path', { d: "M3 3v5h5" }], ['path', { d: "M12 7v5l4 2" }]],
  'audio-waveform': [['path', { d: "M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2" }]],
  'book-open': [['path', { d: "M12 7v14" }], ['path', { d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" }]],
  'briefcase': [['path', { d: "M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" }], ['rect', { width: "20", height: "14", x: "2", y: "6", rx: "2" }]],
  'brain': [['path', { d: "M12 18V5" }], ['path', { d: "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" }], ['path', { d: "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" }], ['path', { d: "M17.997 5.125a4 4 0 0 1 2.526 5.77" }], ['path', { d: "M18 18a4 4 0 0 0 2-7.464" }], ['path', { d: "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" }], ['path', { d: "M6 18a4 4 0 0 1-2-7.464" }], ['path', { d: "M6.003 5.125a4 4 0 0 0-2.526 5.77" }]],
  'volume': [['path', { d: "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" }], ['path', { d: "M16 9a5 5 0 0 1 0 6" }], ['path', { d: "M19.364 18.364a9 9 0 0 0 0-12.728" }]],
  'network': [['rect', { x: "16", y: "16", width: "6", height: "6", rx: "1" }], ['rect', { x: "2", y: "16", width: "6", height: "6", rx: "1" }], ['rect', { x: "9", y: "2", width: "6", height: "6", rx: "1" }], ['path', { d: "M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" }], ['path', { d: "M12 12V8" }]],
  'panel-left': [['rect', { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ['path', { d: "M9 3v18" }]],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: 16 | 20 | 24;
}

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {ICONS[name].map(([Tag, attrs], i) => (
        <Tag key={i} {...attrs} />
      ))}
    </svg>
  );
}
