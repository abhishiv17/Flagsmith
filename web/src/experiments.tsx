/**
 * Flagsmith Experimentation (Toggle Wars).
 *
 * One place that knows about Flagsmith, so pages only ever ask two questions:
 *   - useVariant(FLAG, VARIANTS): which version does this shopper see? Calling it is what records
 *     the exposure, so call it in the component that actually shows the difference.
 *   - trackConversion(EVENT): the shopper did the thing we are measuring.
 *
 * Start-up: the server hands us the environment key and this browser's visitor hash
 * (GET /api/experiments/config). With no key configured, or if Flagsmith is unreachable, every
 * shopper gets the control version and nothing is sent. Experiments must never break shopping.
 */
import { useEffect, type ReactNode } from 'react';
import flagsmith from '@flagsmith/flagsmith';
import { FlagsmithProvider, useExperiment } from '@flagsmith/flagsmith/react';

/** Flags under test. The value is the Flagsmith feature name. */
export const FLAGS = {
  /** Product page: what reassures a shopper enough to add to cart? */
  productTrustSignal: 'product_trust_signal',
} as const;

/** Variant labels as set on the multivariate flag in Flagsmith. Anything else means control. */
export const TRUST_VARIANTS = ['reviews', 'local-proof'] as const;

/**
 * Conversion events. Names must match the Flagsmith metrics exactly (case-sensitive); an event
 * with no matching metric is dropped silently.
 */
export const EVENTS = {
  /** Any add to cart: product page, cards, "bought together". Primary metric. */
  addToCart: 'add_to_cart',
  /** Pressed "Place order" (our cart or a partner shop's item). */
  checkoutStarted: 'checkout_started',
  /** Order confirmed. Carries the order total in rupees as `value`, for a revenue (Sum) metric. */
  checkoutCompleted: 'checkout_completed',
  /** Sold out here, so the shopper asked to be told when it's back. */
  backInStockAlert: 'back_in_stock_alert',
} as const;

type Config = {
  environmentKey: string | null;
  identity: string;
  apiUrl: string | null;
  eventsUrl: string | null;
};

let started: Promise<boolean> | null = null;

/** Initialise Flagsmith once per page load. Resolves true when experiments are live. */
export function startExperiments(): Promise<boolean> {
  started ??= (async () => {
    try {
      const res = await fetch('/api/experiments/config', { credentials: 'same-origin' });
      if (!res.ok) return false;
      const cfg = (await res.json()) as Config;
      if (!cfg.environmentKey) return false;
      await flagsmith.init({
        environmentID: cfg.environmentKey,
        identity: cfg.identity,
        enableEvents: true,
        ...(cfg.apiUrl ? { api: cfg.apiUrl } : {}),
        ...(cfg.eventsUrl ? { eventProcessorConfig: { eventsApiUrl: cfg.eventsUrl } } : {}),
      });
      // Events are batched every 10 s; send what's left when the tab is hidden or closed.
      const flush = () => void flagsmith.flushEvents().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
      });
      window.addEventListener('pagehide', flush);
      return true;
    } catch {
      return false; // Flagsmith down or blocked: everyone stays on control.
    }
  })();
  return started;
}

/**
 * Wraps the app. Renders at once (no waiting on Flagsmith): components show control until the
 * flags arrive, then re-render with the shopper's variant.
 */
export function ExperimentsProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void startExperiments();
  }, []);
  return <FlagsmithProvider flagsmith={flagsmith}>{children}</FlagsmithProvider>;
}

/**
 * The variant this shopper sees for `flag`, or 'control'. Records one exposure (deduplicated by
 * Flagsmith) when the shopper is enrolled in a running experiment.
 */
export function useVariant<V extends string>(flag: string, variants: readonly V[]): V | 'control' {
  const f = useExperiment(flag);
  if (!f?.enabled) return 'control';
  const label = f.variant ?? (typeof f.value === 'string' ? f.value : undefined);
  return label && (variants as readonly string[]).includes(label) ? (label as V) : 'control';
}

/** Record a conversion for the current shopper. No-op until Flagsmith is live. */
export function trackConversion(event: string, value?: number): void {
  try {
    if (!flagsmith.eventsEnabled) return;
    flagsmith.trackEvent(event, value === undefined ? undefined : { value });
  } catch {
    /* analytics must never break shopping */
  }
}
