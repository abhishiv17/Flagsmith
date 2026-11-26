import { useEffect, useRef } from 'react';
import { gsap, reducedMotion } from '../motion';

/**
 * StockHop mark: a lowercase "h" whose second leg is a hop. The stem is the shelf (stock),
 * the arc is the hop, the dot is where it lands (you, in your city).
 * Geometry lives on a 48-unit grid so it stays crisp from 16 px favicons up.
 */
export function Mark({ size = 28, mono = false, animate = false }: { size?: number; mono?: boolean; animate?: boolean }) {
  const arc = useRef<SVGPathElement>(null);
  const dot = useRef<SVGCircleElement>(null);

  // Signature motion: the arc draws itself, then the dot drops in and settles.
  useEffect(() => {
    if (!animate || reducedMotion() || !arc.current || !dot.current) return;
    const len = arc.current.getTotalLength();
    const tl = gsap.timeline({ delay: 0.15 });
    tl.fromTo(arc.current, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 0.7, ease: 'power2.inOut' })
      .fromTo(dot.current, { y: -14, scale: 0, transformOrigin: '50% 50%' }, { y: 0, scale: 1, duration: 0.6, ease: 'bounce.out' }, '-=0.15');
    return () => {
      tl.kill();
    };
  }, [animate]);

  const ink = mono ? 'currentColor' : 'var(--ink)';
  const hop = mono ? 'currentColor' : 'var(--cobalt)';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="mark">
      <rect x="5" y="4" width="9" height="40" rx="4.5" fill={ink} />
      <path ref={arc} d="M9.5 31 C 10 12, 33 9, 36.5 30" fill="none" stroke={hop} strokeWidth="9" strokeLinecap="round" />
      <circle ref={dot} cx="37" cy="40" r="4.5" fill={hop} />
    </svg>
  );
}

/** Full lockup: mark + wordmark. */
export function Logo({ size = 28, animate = false, mono = false }: { size?: number; animate?: boolean; mono?: boolean }) {
  return (
    <span className="logo-lockup" style={{ fontSize: size * 0.82 }}>
      <Mark size={size} animate={animate} mono={mono} />
      <span className="wordmark">
        stock<span className="wordmark-hop">hop</span>
      </span>
    </span>
  );
}
