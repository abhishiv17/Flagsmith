# Working on this repo

## Branches

There is one long-lived branch: **`main`**. It should always build and deploy.

- Small changes go straight to `main`.
- Open a short-lived branch only when a change is large or risky enough to need review first. Merge it with a pull request and delete it once it's merged.
- Pull before you start (`git pull --rebase`) and push small commits often. Long-running branches end in merge conflicts.

## Commits

- One logical change per commit, with a message that says what changed and why, for example `feat(product): reviews version of the trust signal`.
- Run `npm run typecheck` and `npm test` before pushing.
- Never commit `.env`, anything in `certs/`, or keys. The Flagsmith client-side key is public, but it still belongs in environment variables, not in code.

## Adding an experiment

1. Add the flag name and its variant labels to `FLAGS` in [`web/src/experiments.tsx`](../web/src/experiments.tsx).
2. Call `useVariant(...)` in the component that shows the difference, and nowhere else: calling it records an exposure.
3. Add any new conversion event to `EVENTS`, call `trackConversion(...)` where it happens, and create a metric in Flagsmith with exactly the same name.
4. Write the hypothesis, metrics and decision rule down in [experiment.md](experiment.md) **before** launching.
