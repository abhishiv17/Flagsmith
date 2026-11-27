/**
 * The product_trust_signal experiment as data (doc/experiment.md), shared by the Flagsmith setup
 * and results script (scripts/experiment.ts). The browser side lives in web/src/experiments.tsx;
 * experiment-spec.test.ts fails if the two ever disagree on a flag, variant or event name.
 */
export const EXPERIMENT = {
  name: 'Reviews on the product page',
  flag: 'product_trust_signal',
  control: 'control',
  variants: ['reviews'] as const,
  hypothesis:
    'Showing reviews on the product page (average rating, count and a recent review, with a full reviews section below) ' +
    'raises the share of shoppers who add the product to their cart by at least 10% compared with the page without reviews.',
  /** Pre-registered in doc/experiment.md. */
  decisionRule:
    'Ship reviews when win probability on add_to_cart is at least 95% and the revenue guardrail is not worse; otherwise keep control.',
  winProbabilityToShip: 0.95,
} as const;

export type MetricSpec = {
  /** Shown in Flagsmith. Unique per environment. */
  name: string;
  event: string;
  aggregation: 'occurrence' | 'count' | 'sum' | 'mean';
  direction: 'up' | 'down';
  role: 'primary' | 'secondary' | 'guardrail' | 'informational';
};

/** Primary first. Event names are case-sensitive and must match trackConversion() calls. */
export const METRICS: MetricSpec[] = [
  { name: 'Add to cart', event: 'add_to_cart', aggregation: 'occurrence', direction: 'up', role: 'primary' },
  { name: 'Checkout started', event: 'checkout_started', aggregation: 'occurrence', direction: 'up', role: 'secondary' },
  { name: 'Order completed', event: 'checkout_completed', aggregation: 'occurrence', direction: 'up', role: 'secondary' },
  { name: 'Revenue', event: 'checkout_completed', aggregation: 'sum', direction: 'up', role: 'guardrail' },
  { name: 'Back-in-stock alert', event: 'back_in_stock_alert', aggregation: 'occurrence', direction: 'up', role: 'informational' },
  { name: 'Review submitted', event: 'review_submitted', aggregation: 'occurrence', direction: 'up', role: 'informational' },
];
