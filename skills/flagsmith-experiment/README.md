# flagsmith-experiment: an Agent Skill (Track 04)

An [Agent Skill](https://agentskills.io/specification) that takes a coding agent through a **whole Flagsmith Experimentation job with the Flagsmith CLI**:

pre-flight → brief → approved plan → flag with keyed variants → metrics → experiment → SDK code → start → verify traffic → results → decision → rollout with the same flag → clean-up.

We built it while running our own experiment on StockHop ([doc/experiment.md](../../doc/experiment.md)). Every step is one we did by hand first.

## Install

Copy the folder into a skills directory your agent reads:

```bash
# Claude Code, this project only
mkdir -p .claude/skills && cp -r skills/flagsmith-experiment .claude/skills/
# or for every project
cp -r skills/flagsmith-experiment ~/.claude/skills/
```

Requirements: [Flagsmith CLI](https://docs.flagsmith.com/integrating-with-flagsmith/CLI) v2+ (`flagsmith login` done), an environment with a connected warehouse, and an app on an SDK with Experimentation support.

Then ask, for example: *"Use the flagsmith-experiment skill to test whether showing reviews on the product page raises add_to_cart."*

## How it is judged, and what we did about it

| Track 04 criterion | In this skill |
|---|---|
| **Completes the whole job** | Eleven steps, from the warehouse check through rollout and clean-up. It stops with a reason when a prerequisite is missing (no warehouse, an SDK too old to send events) |
| **Token efficiency** | `SKILL.md` stays short. Request bodies, troubleshooting and SDK code sit in `references/` and load only at the step that needs them. Every CLI call uses `--jq`, there are no repeated list calls, and each step reports in 3 lines or fewer |
| **Creative use of the CLI** | `flagsmith api … -X POST --input -` with heredoc bodies covers metrics, experiments and results. `--jq` pulls out ids so later steps chain without re-reading JSON. `flagsmith config` and `flagsmith.json` mean projects and environments are never listed twice |
| **Safety around production** | Nothing changes without an approved plan. Create, start and end each ask again, and in an environment named prod/live the user must type its name. The skill never touches a running experiment's flag and never puts Admin keys in code. It decides by a rule written before any data. Ending is a dashboard click it explains, never a guessed API call |

## Demo run

| | |
|---|---|
| Agent | Claude Code, fresh session, only this skill installed |
| Target | StockHop, Flagsmith **Simulation** environment, throwaway flag `sim_skill_demo` |
| Prompt | "Use the flagsmith-experiment skill to test whether showing reviews on the product page raises add_to_cart." |
| Result | _fill in: experiment id, status `running`, results read_ |
| Tokens | _fill in from the session's usage summary at the end of the run_ |
| Recording | _link_ |

## Files

| File | Loaded |
|---|---|
| `SKILL.md` | When the skill activates: rules, token discipline, the 11 steps |
| `references/api.md` | Steps 4, 5 and 9: exact request bodies and how to read the results |
| `references/sdk-snippets.md` | Step 6: exposure and conversion code per SDK |
| `references/troubleshooting.md` | Step 8, only if exposures or conversions don't appear |

`server/lib/skill.test.ts` checks the frontmatter against the Agent Skills spec (name format and directory match, description length).
