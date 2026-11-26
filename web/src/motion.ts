import { useLayoutEffect, type DependencyList, type RefObject } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import 'lenis/dist/lenis.css';

/**
 * All GSAP motion lives here. Rules:
 * - Every animation starts from the element's real, visible state, so if a script fails or motion
 *   is reduced, the page is still complete.
 * - Anything bound to a component runs inside gsap.context and is reverted on unmount.
 * - prefers-reduced-motion: no movement at all (CSS hover states still work).
 */

gsap.registerPlugin(ScrollTrigger);
gsap.defaults({ ease: 'power3.out', duration: 0.7 });
// Catch up to real time after a stalled frame instead of slowing down, so an intro never
// gets stuck half-way in a throttled or background tab (the page must be complete at rest).
gsap.ticker.lagSmoothing(0);

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- Smooth scroll (Lenis, driven by GSAP's ticker) ---------------- */

let lenis: Lenis | null = null;

/** Start Lenis once for the whole app. Skipped when motion is reduced (native scroll then). */
export function startSmoothScroll() {
  if (lenis || reducedMotion()) return;
  lenis = new Lenis({ lerp: 0.1, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis?.raf(time * 1000));
}

/** Jump to the top on route change, respecting Lenis when it's running. */
export function scrollToTop() {
  if (lenis) lenis.scrollTo(0, { immediate: true });
  else window.scrollTo(0, 0);
}

/** Pause page scrolling (full-screen menu, preloader). */
export function lockScroll(locked: boolean) {
  if (lenis) (locked ? lenis.stop() : lenis.start());
  document.documentElement.style.overflow = locked ? 'hidden' : '';
}

/** Run GSAP code scoped to `scope`, reverted on unmount or when deps change. */
export function useGsap(effect: () => void, deps: DependencyList, scope?: RefObject<Element | null>) {
  useLayoutEffect(() => {
    if (reducedMotion()) return;
    const ctx = gsap.context(effect, scope?.current ?? undefined);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* ---------------- Page-level ---------------- */

/** Soft entrance for each new route. */
export function pageEnter(main: Element | null) {
  if (!main || reducedMotion()) return;
  gsap.fromTo(main, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.55, clearProps: 'transform,opacity,visibility' });
}

/** Full-screen menu: panel drops in, big links rise one after another. */
export function menuOpen(panel: Element) {
  if (reducedMotion()) return;
  gsap.timeline()
    .fromTo(panel, { clipPath: 'circle(0% at 48px 48px)' }, { clipPath: 'circle(150% at 48px 48px)', duration: 0.7, ease: 'power3.inOut' })
    .from(panel.querySelectorAll('.menu-link span'), { yPercent: 110, stagger: 0.06, duration: 0.6, ease: 'power4.out' }, '-=0.3')
    .from(panel.querySelectorAll('.menu-foot > *'), { y: 14, autoAlpha: 0, stagger: 0.05, duration: 0.4 }, '-=0.3');
}

/* ---------------- Home ---------------- */

/**
 * Hero intro, which also explains the idea: the promise rises line by line, the product settles,
 * then each city's shelf pops in as its connector draws (one product, three stores). If your
 * store is out, the dashed hop to the nearest city draws last.
 */
export function heroIntro(root: HTMLElement) {
  gsap.timeline()
    .from(root.querySelectorAll('.r-title .line > span'), { yPercent: 110, duration: 1, stagger: 0.12, ease: 'power4.out' })
    .from(root.querySelectorAll('.r-copy > :not(h1)'), { y: 16, autoAlpha: 0, stagger: 0.08, duration: 0.6 }, '-=0.6');
}

/** Stock map, once its city counts have loaded: product settles, connectors draw, shelves pop in, hop draws. */
export function stockMapIntro(map: HTMLElement) {
  const prep = (p: SVGPathElement) => {
    const len = p.getTotalLength();
    gsap.set(p, { strokeDasharray: p.classList.contains('smap-hop') ? `${len}` : len, strokeDashoffset: len });
  };
  const lines = Array.from(map.querySelectorAll<SVGPathElement>('.smap-line'));
  const hop = Array.from(map.querySelectorAll<SVGPathElement>('.smap-hop'));
  [...lines, ...hop].forEach(prep);

  gsap.timeline({ delay: 0.3 })
    .from(map.querySelector('.smap-product'), { y: 40, scale: 0.85, autoAlpha: 0, duration: 0.9, ease: 'back.out(1.4)' })
    .to(lines, { strokeDashoffset: 0, duration: 0.6, stagger: 0.15, ease: 'power2.out' }, '-=0.3')
    .from(map.querySelectorAll('.smap-city'), { scale: 0.6, autoAlpha: 0, duration: 0.5, stagger: 0.15, ease: 'back.out(2)' }, '<0.2')
    .to(hop, { strokeDashoffset: 0, duration: 0.9, ease: 'power2.inOut', onComplete: () => hop.forEach((p) => p.removeAttribute('style')) })
    .from(map.querySelector('.smap-caption'), { autoAlpha: 0, y: 8, duration: 0.5 }, '<');

  gsap.to(map.querySelector('.smap-product'), { y: -10, duration: 2.8, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 2.5 });
}

/**
 * Products carousel: the outgoing product spins away, the next one swings in from the other
 * side; the big circle breathes and the counter digits roll. `dir` is +1 (next) or -1 (prev).
 */
export function carouselSwap(root: HTMLElement, dir: 1 | -1, swap: () => void) {
  const stage = root.querySelector('.pc-product');
  const meta = root.querySelectorAll('.pc-meta > *');
  const num = root.querySelector('.pc-count b');
  if (reducedMotion() || !stage) return swap();
  gsap.timeline()
    .to(stage, { xPercent: -60 * dir, rotation: -35 * dir, autoAlpha: 0, duration: 0.4, ease: 'power2.in' })
    .to(meta, { y: -16, autoAlpha: 0, duration: 0.25, stagger: 0.03 }, 0)
    .to(num, { yPercent: -100 * dir, autoAlpha: 0, duration: 0.25 }, 0)
    .to(root.querySelector('.pc-circle'), { scale: 0.92, duration: 0.4, ease: 'power2.in' }, 0)
    .add(swap)
    .fromTo(stage, { xPercent: 60 * dir, rotation: 35 * dir, autoAlpha: 0 }, { xPercent: 0, rotation: 0, autoAlpha: 1, duration: 0.7, ease: 'back.out(1.4)' })
    .fromTo(num, { yPercent: 100 * dir, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.4 }, '<')
    .fromTo(meta, { y: 16, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.45, stagger: 0.05 }, '<0.1')
    .to(root.querySelector('.pc-circle'), { scale: 1, duration: 0.8, ease: 'elastic.out(1, 0.5)' }, '<');
}

/** Carousel ambience: rings slowly pulse outward; the section's wave edges drift on scroll. */
export function carouselAmbience(root: HTMLElement) {
  gsap.fromTo(root.querySelectorAll('.pc-rings circle'),
    { scale: 0.96, transformOrigin: '50% 50%', opacity: 0.55 },
    { scale: 1.04, opacity: 1, duration: 2.4, ease: 'sine.inOut', yoyo: true, repeat: -1, stagger: 0.4 });
  gsap.to(root.querySelectorAll('.wave path'), {
    xPercent: -6, ease: 'none', scrollTrigger: { trigger: root, start: 'top bottom', end: 'bottom top', scrub: 1 },
  });
  gsap.from(root.querySelectorAll('.pc-head > *'), {
    yPercent: 60, autoAlpha: 0, stagger: 0.1, duration: 0.8, ease: 'power4.out',
    scrollTrigger: { trigger: root, start: 'top 70%', once: true },
  });
}

/** Category cards start stacked in the middle, then fan out along an arc as you scroll in. */
export function fanCards(root: HTMLElement) {
  const cards = gsap.utils.toArray<HTMLElement>(root.querySelectorAll('.arc-card'));
  const n = cards.length;
  const mid = (n - 1) / 2;
  // Wide screens only: phones get a plain two-column grid.
  const mm = gsap.matchMedia();
  mm.add('(min-width: 761px)', () => {
    gsap.fromTo(cards,
      { xPercent: (i: number) => (mid - i) * 100, y: 60, rotation: 0 },
      {
        xPercent: 0, y: (i: number) => Math.abs(i - mid) * Math.abs(i - mid) * 18, rotation: (i: number) => (i - mid) * 7,
        ease: 'power2.out',
        scrollTrigger: { trigger: root, start: 'top 85%', end: 'top 25%', scrub: 0.8 },
      });
  });
  return () => mm.revert();
}

/** Section headings: script lead-in, then each heading line rises from a mask. */
export function headingReveal(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.sec-head').forEach((h) => {
    gsap.from(h.querySelectorAll('.script, .line > span'), {
      yPercent: 100, autoAlpha: 0, stagger: 0.1, duration: 0.9, ease: 'power4.out',
      scrollTrigger: { trigger: h, start: 'top 85%', once: true },
    });
  });
}

/**
 * "The commute kit" scroll story (after the exploded-view "ingredient ballet" pattern).
 * The stage pins for ~2.6 screens while scroll scrubs three chapters:
 *   1. the hero product settles in;
 *   2. companions spiral out from behind it to their orbit slots, labels draw in;
 *   3. labels retract and everything drops into the bag; the call to action appears.
 * CSS already places every orb at its slot, so the static layout is the finished kit.
 */
export function kitStory(root: HTMLElement) {
  const stage = root.querySelector<HTMLElement>('.kit-stage');
  const scene = root.querySelector<HTMLElement>('.kit-scene');
  if (!stage || !scene) return;
  const orbs = gsap.utils.toArray<HTMLElement>(root.querySelectorAll('.kit-orb'));
  const labels = root.querySelectorAll('.orb-label');
  const hero = root.querySelector('.kit-hero');
  const bag = root.querySelector('.kit-bag');
  const orbit = root.querySelector('.kit-orbit');
  const ch1 = root.querySelector('[data-chapter="1"]');
  const ch2 = root.querySelector('[data-chapter="2"]');
  const ch3 = root.querySelector('[data-chapter="3"]');
  const index = root.querySelectorAll('.kit-index li');
  const bar = root.querySelector('.kit-progress span');
  if (!hero || !bag || !orbit || !ch1 || !ch2 || !ch3) return;

  root.classList.add('is-animated');

  const W = () => scene.clientWidth;
  const H = () => scene.clientHeight;
  const sx = (el: HTMLElement) => (Number(el.dataset.x) / 100) * W();
  const sy = (el: HTMLElement) => (Number(el.dataset.y) / 100) * H();
  const bagY = () => H() * 0.3;

  // Gentle idle float, independent of scroll: the "ballet".
  gsap.to(root.querySelectorAll('.orb-img'), {
    y: -8, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1, stagger: { each: 0.35, from: 'random' },
  });

  const tl = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: root,
      start: 'top top',
      end: '+=260%',
      pin: stage,
      scrub: 0.8,
      invalidateOnRefresh: true,
      onUpdate: (self) => {
        if (bar) gsap.set(bar, { scaleY: self.progress });
        const active = self.progress < 0.2 ? 0 : self.progress < 0.62 ? 1 : 2;
        index.forEach((li, i) => li.classList.toggle('is-active', i === active));
      },
    },
  });

  // Starting state: companions tucked behind the hero, chapters 2 and 3 waiting.
  tl.set(orbs, { xPercent: -50, yPercent: -50, x: (_i: number, el: HTMLElement) => -sx(el), y: (_i: number, el: HTMLElement) => -sy(el), scale: 0.2, autoAlpha: 0, rotation: 80 }, 0)
    .set(labels, { autoAlpha: 0 }, 0)
    .set([ch2, ch3], { autoAlpha: 0, y: 30 }, 0)
    .set(bag, { xPercent: -50, yPercent: -50, autoAlpha: 0, scale: 0.6 }, 0)
    .set(hero, { xPercent: -50, yPercent: -50 }, 0);

  // 1. The pick
  tl.fromTo(hero, { scale: 0.7, rotation: -6 }, { scale: 1, rotation: 0, duration: 1.5, ease: 'power2.out' }, 0);

  // 2. The kit: spiral out (the orbit container unwinds while each orb travels outward)
  tl.to(ch1, { autoAlpha: 0, y: -30, duration: 0.8 }, 1.4)
    .to(ch2, { autoAlpha: 1, y: 0, duration: 0.8 }, 1.8)
    .fromTo(orbit, { rotation: -75 }, { rotation: 0, duration: 2.8, ease: 'power2.out' }, 1.8)
    .to(orbs, { x: 0, y: 0, scale: 1, autoAlpha: 1, rotation: 0, duration: 2.2, stagger: 0.18, ease: 'power3.out' }, 1.8)
    .to(hero, { scale: 0.86, duration: 2 }, 1.8)
    .fromTo(labels, { autoAlpha: 0, y: -10 }, { autoAlpha: 1, y: 0, duration: 0.7, stagger: 0.1 }, 3.9)
    .to({}, { duration: 1.4 }); // hold so the labels can be read

  // 3. Your bag: everything drops in
  tl.to(labels, { autoAlpha: 0, duration: 0.5 }, 6.2)
    .to(bag, { autoAlpha: 1, scale: 1, y: () => bagY(), duration: 0.8, ease: 'back.out(1.6)' }, 6.3)
    .to(orbs, { x: (_i: number, el: HTMLElement) => -sx(el), y: (_i: number, el: HTMLElement) => bagY() - sy(el), scale: 0.15, autoAlpha: 0, duration: 1.6, stagger: 0.1, ease: 'power2.in' }, 6.5)
    .to(hero, { y: () => bagY(), scale: 0.2, autoAlpha: 0, duration: 1.4, ease: 'power2.in' }, 7)
    .to(ch2, { autoAlpha: 0, y: -30, duration: 0.6 }, 6.6)
    .to(ch3, { autoAlpha: 1, y: 0, duration: 0.8 }, 7.2)
    .fromTo(root.querySelector('.kit-bag-count'), { scale: 0 }, { scale: 1, duration: 0.5, ease: 'back.out(3)' }, 8.3)
    .to({}, { duration: 1.2 });

  return () => root.classList.remove('is-animated');
}

/** Endless horizontal ticker. The track holds two identical lists, so shifting by half loops seamlessly. */
export function marquee(selector: string) {
  const track = document.querySelector<HTMLElement>(selector);
  if (!track) return;
  const pxPerSecond = 60;
  const tween = gsap.to(track, { xPercent: -50, ease: 'none', repeat: -1, duration: track.scrollWidth / 2 / pxPerSecond });
  // Slow right down while the shopper reads an item.
  const slow = () => gsap.to(tween, { timeScale: 0.15, duration: 0.4 });
  const resume = () => gsap.to(tween, { timeScale: 1, duration: 0.4 });
  track.addEventListener('mouseenter', slow);
  track.addEventListener('mouseleave', resume);
  return () => {
    track.removeEventListener('mouseenter', slow);
    track.removeEventListener('mouseleave', resume);
  };
}

/** Cards rise in as they scroll into view, in small staggered batches. */
export function revealCards(selector = '.grid .card') {
  const cards = gsap.utils.toArray<HTMLElement>(selector);
  if (cards.length === 0) return;
  gsap.set(cards, { autoAlpha: 0, y: 28 });
  ScrollTrigger.batch(cards, {
    start: 'top 92%',
    once: true,
    onEnter: (batch) => gsap.to(batch, { autoAlpha: 1, y: 0, stagger: 0.07, duration: 0.7, overwrite: true }),
  });
  // Cards already on screen fire immediately; refresh so positions are measured after layout.
  ScrollTrigger.refresh();
}

/* ---------------- Live stock ---------------- */

/** A stock number changed under the shopper: roll the digits and flash an accent ring. */
export function stockChanged(card: Element | null, qtyEl: Element | null) {
  if (reducedMotion()) return;
  if (qtyEl) gsap.fromTo(qtyEl, { yPercent: -80, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1, duration: 0.45, ease: 'back.out(2)' });
  const ring = card?.querySelector('.live-ring');
  if (ring) gsap.fromTo(ring, { autoAlpha: 1 }, { autoAlpha: 0, duration: 1.4, ease: 'power2.in', delay: 0.3 });
  if (card) gsap.fromTo(card, { scale: 1.015 }, { scale: 1, duration: 0.6, ease: 'elastic.out(1, 0.5)', clearProps: 'scale' });
}

/* ---------------- Cart ---------------- */

/** Clone the product image, fly it into the cart button, then bounce the count. */
export function flyToCart(source: Element | null) {
  const target = document.querySelector('.cart-btn');
  const bump = () => {
    const count = document.querySelector('.cart-btn .count');
    if (count && !reducedMotion()) gsap.fromTo(count, { scale: 1.5 }, { scale: 1, duration: 0.7, ease: 'elastic.out(1.2, 0.4)' });
  };
  if (!source || !target || reducedMotion()) return bump();

  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const clone = source.cloneNode(true) as HTMLElement;
  clone.classList.add('fly');
  Object.assign(clone.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.appendChild(clone);

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  gsap
    .timeline({ onComplete: () => { clone.remove(); bump(); } })
    .to(clone, { scale: 0.9, duration: 0.15, ease: 'power1.out' })
    .to(clone, { x: dx, duration: 0.7, ease: 'power2.inOut' }, '>')
    .to(clone, { y: dy, duration: 0.7, ease: 'back.in(1.4)' }, '<')
    .to(clone, { scale: 0.12, borderRadius: '50%', autoAlpha: 0.6, duration: 0.7, ease: 'power2.in' }, '<');
}

/* ---------------- Product page ---------------- */

/** Photo unmasks from a rounded inset while the details cascade in. */
export function productIntro() {
  const tl = gsap.timeline();
  tl.from('.pdp-art', { clipPath: 'inset(8% 8% 8% 8% round 28px)', duration: 1.1, ease: 'expo.out' })
    .from('.pdp-art .art', { scale: 1.12, duration: 1.4, ease: 'expo.out' }, '<')
    .from('.pdp-info > *', { y: 18, autoAlpha: 0, stagger: 0.05, duration: 0.6 }, '<0.15')
    .from('.stock-table tbody tr', { x: -12, autoAlpha: 0, stagger: 0.06, duration: 0.45 }, '<0.3');
}

/* ---------------- Order ---------------- */

/** "Confirmation sent": draw the tick. */
export function drawCheck(path: SVGPathElement | null) {
  if (!path || reducedMotion()) return;
  const len = path.getTotalLength();
  gsap.fromTo(path, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 0.6, ease: 'power2.out' });
  gsap.fromTo(path.closest('.confirm'), { scale: 0.94 }, { scale: 1, duration: 0.6, ease: 'back.out(2.2)' });
}

/** Order number types itself in, character by character. */
export function orderIntro() {
  gsap.from('.order-hero > *', { y: 16, autoAlpha: 0, stagger: 0.08, duration: 0.6 });
  gsap.from('.order-no .ch', { yPercent: 100, autoAlpha: 0, stagger: 0.035, duration: 0.5, ease: 'back.out(1.8)', delay: 0.15 });
}

/* ---------------- Generic ---------------- */

/** Stagger a list of siblings in (cart lines, ops tiles). */
export function staggerIn(selector: string, opts: gsap.TweenVars = {}) {
  const els = gsap.utils.toArray<HTMLElement>(selector);
  if (els.length) gsap.from(els, { y: 18, autoAlpha: 0, stagger: 0.06, duration: 0.55, ...opts });
}

/** City picker: backdrop fades, panel rises, choices cascade. */
export function modalIn(root: Element | null) {
  if (!root || reducedMotion()) return;
  gsap.fromTo(root, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, ease: 'power1.out' });
  gsap.fromTo(root.querySelector('.modal'), { y: 30, scale: 0.97 }, { y: 0, scale: 1, duration: 0.6, ease: 'expo.out' });
  gsap.fromTo(root.querySelectorAll('.city-choice'), { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, stagger: 0.06, duration: 0.5, delay: 0.12 });
}

export { gsap, ScrollTrigger };
