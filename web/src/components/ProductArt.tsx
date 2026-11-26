import type { ReactNode } from 'react';

/** Flat SVG product illustrations: the fallback for products without a photo (ProductImage.tsx). */

// Fallback when a product has no photo yet (see productPhotos.ts). Muted to sit beside real photos.
const INK = '#2a2c30';
const BLUE = '#2f5bff';

const TILE: Record<string, string> = { buds: 'var(--tile-a)', speaker: 'var(--tile-c)', bottle: 'var(--tile-b)' };
const ROTATION = ['var(--tile-a)', 'var(--tile-b)', 'var(--tile-c)'];

const N = { fill: 'none' } as const;

const SHAPES: Record<string, ReactNode> = {
  buds: (
    <>
      <rect x="34" y="66" width="10" height="30" rx="5" />
      <rect x="28" y="38" width="22" height="36" rx="11" />
      <circle cx="39" cy="52" r="5" fill={BLUE} />
      <rect x="76" y="66" width="10" height="30" rx="5" />
      <rect x="70" y="38" width="22" height="36" rx="11" />
      <circle cx="81" cy="52" r="5" fill={BLUE} />
    </>
  ),
  speaker: (
    <>
      <rect x="30" y="20" width="60" height="82" rx="10" />
      <circle cx="60" cy="74" r="17" fill={BLUE} />
      <circle cx="60" cy="40" r="7" fill={INK} />
    </>
  ),
  headphones: (
    <>
      <path d="M28 70 V58 a32 32 0 0 1 64 0 V70" {...N} strokeWidth={6} />
      <rect x="18" y="62" width="22" height="34" rx="6" fill={BLUE} />
      <rect x="80" y="62" width="22" height="34" rx="6" fill={BLUE} />
    </>
  ),
  neckband: (
    <>
      <path d="M30 42 C30 100, 90 100, 90 42" {...N} strokeWidth={8} />
      <circle cx="30" cy="36" r="9" fill={BLUE} />
      <circle cx="90" cy="36" r="9" fill={BLUE} />
      <rect x="50" y="78" width="20" height="12" rx="4" />
    </>
  ),
  wired: (
    <>
      <path d="M40 42 C40 70, 60 70, 60 94 M80 42 C80 70, 60 70, 60 94" {...N} />
      <circle cx="40" cy="34" r="9" fill={BLUE} />
      <circle cx="80" cy="34" r="9" fill={BLUE} />
      <rect x="54" y="92" width="12" height="16" rx="2" fill={INK} />
    </>
  ),
  soundbar: (
    <>
      <rect x="12" y="46" width="96" height="28" rx="8" />
      <circle cx="32" cy="60" r="6" fill={BLUE} />
      <circle cx="60" cy="60" r="6" fill={BLUE} />
      <circle cx="88" cy="60" r="6" fill={BLUE} />
      <rect x="30" y="78" width="60" height="6" fill={INK} />
    </>
  ),
  band: (
    <>
      <rect x="48" y="12" width="24" height="96" rx="12" fill={BLUE} />
      <rect x="40" y="42" width="40" height="36" rx="8" />
      <path d="M48 60 h8 l4 -8 l4 14 l4 -6 h4" {...N} />
    </>
  ),
  watch: (
    <>
      <rect x="44" y="10" width="32" height="100" rx="8" fill={BLUE} />
      <circle cx="60" cy="60" r="27" />
      <path d="M60 45 V60 L70 66" {...N} />
    </>
  ),
  clip: (
    <>
      <path d="M50 32 V18 H70 V32" {...N} />
      <rect x="36" y="30" width="48" height="64" rx="14" />
      <rect x="48" y="44" width="24" height="18" rx="3" fill={BLUE} />
    </>
  ),
  ring: (
    <>
      <circle cx="60" cy="68" r="28" {...N} strokeWidth={10} />
      <path d="M48 40 L52 28 H68 L72 40 Z" fill={BLUE} />
    </>
  ),
  charger: (
    <>
      <rect x="46" y="24" width="8" height="22" fill={INK} />
      <rect x="66" y="24" width="8" height="22" fill={INK} />
      <rect x="34" y="44" width="52" height="54" rx="8" />
      <path d="M64 56 l-10 15 h12 l-10 15" {...N} stroke={BLUE} />
    </>
  ),
  cable: (
    <>
      <path d="M32 30 C92 30, 28 90, 88 90" {...N} strokeWidth={6} />
      <rect x="14" y="22" width="22" height="16" rx="3" fill={BLUE} />
      <rect x="84" y="82" width="22" height="16" rx="3" fill={BLUE} />
    </>
  ),
  powerbank: (
    <>
      <rect x="36" y="14" width="48" height="92" rx="8" />
      <rect x="48" y="30" width="24" height="10" fill={BLUE} />
      <rect x="48" y="46" width="24" height="10" fill={BLUE} />
      <rect x="48" y="62" width="24" height="10" fill={BLUE} />
      <circle cx="60" cy="90" r="4" fill={INK} />
    </>
  ),
  stand: (
    <>
      <path d="M26 100 H94" {...N} strokeWidth={6} />
      <path d="M62 100 L48 72" {...N} strokeWidth={6} />
      <g transform="rotate(-12 58 50)">
        <rect x="38" y="16" width="40" height="68" rx="6" fill={BLUE} />
        <rect x="44" y="24" width="28" height="48" rx="2" />
      </g>
    </>
  ),
  pad: (
    <>
      <circle cx="60" cy="62" r="38" />
      <circle cx="60" cy="62" r="25" fill={BLUE} />
      <path d="M65 47 l-10 15 h12 l-10 15" {...N} stroke="#fff" />
    </>
  ),
  bottle: (
    <>
      <rect x="47" y="10" width="26" height="18" rx="3" fill={INK} />
      <rect x="38" y="28" width="44" height="84" rx="12" />
      <rect x="38" y="56" width="44" height="22" fill={BLUE} />
    </>
  ),
  lunchbox: (
    <>
      <rect x="52" y="28" width="16" height="10" fill={INK} />
      <rect x="22" y="46" width="76" height="52" rx="8" />
      <rect x="18" y="36" width="84" height="14" rx="4" fill={BLUE} />
    </>
  ),
  mug: (
    <>
      <path d="M78 44 h10 a10 10 0 0 1 10 10 v12 a10 10 0 0 1 -10 10 h-10" {...N} />
      <rect x="28" y="28" width="50" height="70" rx="8" />
      <rect x="28" y="50" width="50" height="16" fill={BLUE} />
    </>
  ),
  lamp: (
    <>
      <path d="M50 98 L38 58 L72 36" {...N} strokeWidth={6} />
      <rect x="26" y="96" width="48" height="10" rx="3" fill={INK} />
      <path d="M64 26 L98 44 L84 62 Z" fill={BLUE} />
    </>
  ),
  kettle: (
    <>
      <path d="M40 58 L20 46" {...N} strokeWidth={6} />
      <path d="M80 54 h10 a12 12 0 0 1 0 28 h-6" {...N} />
      <path d="M34 102 L40 44 H80 L86 102 Z" />
      <rect x="48" y="30" width="24" height="14" rx="4" fill={BLUE} />
    </>
  ),
  fan: (
    <>
      <path d="M60 90 V104 M44 106 H76" {...N} strokeWidth={6} />
      <circle cx="60" cy="54" r="38" />
      <path d="M60 54 C58 30, 82 28, 78 46 Z M60 54 C84 58, 80 82, 64 74 Z M60 54 C44 74, 26 62, 38 46 Z" fill={BLUE} />
      <circle cx="60" cy="54" r="6" fill={INK} />
    </>
  ),
  backpack: (
    <>
      <path d="M44 32 a16 16 0 0 1 32 0" {...N} />
      <rect x="28" y="30" width="64" height="80" rx="16" />
      <rect x="40" y="70" width="40" height="28" rx="6" fill={BLUE} />
    </>
  ),
  sleeve: (
    <>
      <rect x="16" y="34" width="88" height="58" rx="8" fill={BLUE} />
      <path d="M24 48 H96" {...N} stroke="#fff" />
      <rect x="84" y="42" width="10" height="12" rx="2" />
    </>
  ),
  pouch: (
    <>
      <path d="M22 44 H98 L88 98 H32 Z" />
      <path d="M22 44 H98" {...N} strokeWidth={6} />
      <rect x="74" y="38" width="10" height="16" fill={BLUE} />
    </>
  ),
  duffel: (
    <>
      <path d="M42 48 a18 18 0 0 1 36 0" {...N} />
      <rect x="14" y="46" width="92" height="52" rx="24" />
      <path d="M36 47 V97 M84 47 V97" {...N} />
      <rect x="48" y="62" width="24" height="12" rx="3" fill={BLUE} />
    </>
  ),
  umbrella: (
    <>
      <path d="M60 60 V96 a8 8 0 0 1 -16 0" {...N} strokeWidth={5} />
      <path d="M14 62 a46 46 0 0 1 92 0 Z" fill={BLUE} />
    </>
  ),
  pillow: (
    <path
      d="M28 42 C28 104, 92 104, 92 42 C92 24, 72 24, 72 42 C72 74, 48 74, 48 42 C48 24, 28 24, 28 42 Z"
      fill={BLUE}
    />
  ),
};

export function tileColor(imageKey: string, productId: number) {
  return TILE[imageKey] ?? ROTATION[productId % 3]!;
}

export function ProductArt({ imageKey, productId, className = '' }: { imageKey: string; productId: number; className?: string }) {
  return (
    <div className={`art ${className}`} style={{ background: tileColor(imageKey, productId) }}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <g fill="#fff" stroke={INK} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round">
          {SHAPES[imageKey] ?? <rect x="30" y="30" width="60" height="60" />}
        </g>
      </svg>
    </div>
  );
}
