# Exposure and conversion code per SDK

Reading the experiment flag records the exposure. Read it only where the difference is shown, and always as the same identity that sends the events.

## JavaScript (`@flagsmith/flagsmith` 12.4.0+)

```ts
import flagsmith from '@flagsmith/flagsmith';

await flagsmith.init({ environmentID: '<client-side key>', identity: userId, enableEvents: true });

const flag = flagsmith.getExperimentFlag('checkout_button'); // records the exposure
const variant = flag?.enabled ? (flag.variant ?? 'control') : 'control';

flagsmith.trackEvent('purchase', { value: 99.5 }); // conversion; value is optional
await flagsmith.flushEvents(); // before a short-lived page or script exits
```

## React (same package)

```tsx
import { FlagsmithProvider, useExperiment } from '@flagsmith/flagsmith/react';

function BuyButton() {
  const f = useExperiment('checkout_button'); // records the exposure when rendered
  return f?.variant === 'big' ? <BigButton /> : <Button />;
}
```

Wrap the app in `<FlagsmithProvider flagsmith={flagsmith}>`. Render control until the flags arrive; don't block the page on Flagsmith.

## Node.js (`@flagsmith/nodejs` 9.1.0+; the old `flagsmith-nodejs` can't send events)

Use the server SDK's identity flags for the experiment flag, and its track-event call for conversions with the same identifier. Check the SDK's README for the exact method names in your version.

## Python (`flagsmith` 6.3.0+)

Get the identity's flags, read the experiment flag (this records the exposure), and track the conversion event for the same identifier. In short-lived scripts, construct the client with `max_buffer_items=1` so events aren't lost on exit.

## Fail safe

If initialisation fails or no key is configured, every user gets control and no events are sent. The feature under test must never break the app.
