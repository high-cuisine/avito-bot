# Testing Guide

## Test Types

- `test:fast` — unit/scenario tests with mocks; fastest regression check.
- `test:live:*` — real LLM API tests for full dialog flows.

## Commands

- Fast local check:
  - `npm run test:fast`
- Live smoke (1 repeat per scenario):
  - `npm run test:live:once`
- Live stable (default, 5 repeats):
  - `npm run test:live`
  - `npm run test:live:stable`
- Live stress (10 repeats):
  - `npm run test:live:stress`

## Required Env For Live

- `OPENAI_API_KEY` must be set in `.env`.
- Optional:
  - `LIVE_LLM_REPEATS` overrides repeats per scenario.

## Where To Add Cases

- Scenario source list:
  - `src/application/conversation/scenario-cases.md`
- Executable mocked scenarios:
  - `src/application/conversation/scenario.test.ts`
- Executable live scenarios:
  - `src/application/conversation/scenario.live.test.ts`

## Live Test Notes

- Live tests print dialog steps (`CLIENT`/`BOT`) to console.
- Each scenario is run multiple times to reduce nondeterminism.
- If a flaky failure appears, rerun with `test:live:once` first to inspect a single trace, then validate with `test:live:stable`.
