# When exposures or conversions don't show up

Check these in order. Each one is a known cause.

| Symptom | Cause | Fix |
|---|---|---|
| No exposures at all | No warehouse connected | Connect one in Environment settings → Warehouse. The first data can take a while to appear |
| No exposures at all | The experiment isn't started, or the rollout is below 100% | Check `status` is `running`. Identities outside the rollout aren't enrolled |
| No exposures for one variant | That variation has no key | Set a key on the variation before starting (`flagsmith feature variant update`, see `--help`) |
| No exposures | The user isn't identified before the experiment flag is requested | Call identify first, then read the flag |
| No exposures (scripts, server jobs) | The process exits before buffered events are sent | `await flagsmith.flushEvents()` (JS), `max_buffer_items=1` (Python) |
| Exposures but no conversions | The event name differs from the metric's event | Names are case-sensitive. Compare `trackEvent(` calls with the metrics |
| Exposures but no conversions | Conversion sent under a different identity than the exposure | Use the same identity for the flag and the events |
| Conversions only from earlier visits | Conversions before the first exposure don't count | Expected. Only events after the identity's first exposure count |
| Some events missing | Event older than 10 days, more than 24 hours in the future, or a batch over 2 MiB | Fix the clock and keep batches small |
| Self-hosted: nothing arrives | The SDK still sends to Flagsmith Cloud | Set the SDK's events URL to your instance (`http://localhost:8000/api/` locally) |
| Uneven split warning | Sample-ratio mismatch: bucketing or exposure is broken | Don't act on the results. Check exposure is recorded on every render path |
