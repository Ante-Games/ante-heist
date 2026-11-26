# Ante Heist: context for agents

This file is the living context for any agent working in this repo. **After any big task, update "Current state" below and prune notes that are no longer true.**

## What this is

Ante Heist is a game for AI agents on NEAR: an agent scouts a building, hires NPC specialists (paid on chain), cracks locks, packs a bag, then submits one plan. A NEAR contract holds a prefunded reward pot, takes the hires and pays out clears. It was built as an entry for the NEAR hackathon (rules: https://nearhackathon.com/HACKATHON.md). `README.md` is the full description written for judges.

- Live game: https://heist.ante.games (Railway service `ante-heist`, NEAR testnet)
- Live contract: `heist.ante-heist-mwahb1id.testnet`, mission `mission-1`
- Repo: public. Every push is a publication.

## Layout

- `game/src`: the game server, TypeScript run directly by Node 24. `game/public`: the web pages and `skill.md`. `game/lead`: demo agents. `game/test`: tests.
- `contract/`: the Rust contract (`near-sdk-rs`), one file, `contract/src/lib.rs`.
- `scripts/`: `testnet.ts` (setup and operations on testnet), `sandbox-e2e.ts`, `near-ops.ts`, `reprice.ts`, `add-analyst.ts`, `upgrade-rehearsal.ts`.

## Run and test

- Node 24 type stripping runs the TypeScript as is: no enums, namespaces or constructor parameter properties. There is no build step.
- `npm install`, then `npm test` (31 tests) and `npm run demo -- --serve`.
- Contract: Rust is pinned to 1.86 (`contract/rust-toolchain.toml`) because newer rustc emits wasm the NEAR VM rejects with this SDK. Build with `cargo near build non-reproducible-wasm` (cargo-near 0.20.3). `npm run test:contract` (17 tests).
- `npm run e2e` runs the whole chain flow on a local NEAR sandbox. Run it after any change to the contract, `chain.ts` or `near-ops.ts`.
- `npm run start:testnet` runs the server against testnet and needs `.env.testnet` (see "Only on the Mac").

## Rules for the code

- The checker (`game/src/checker.ts`) must stay a pure function of (seed, log). Never score agent count.
- The analyst (`game/src/analyst.ts`) is the only NPC that calls a language model. It may only be sent what the player has already seen (`observations()` in `runs.ts`) plus the public rules: never the heist, the seed or the clue bank. The other three NPCs stay deterministic code.
- Clue text (`game/src/content.ts`): every obstacle has its own clue at every tier (no shared clues), but tiers 1-2 must stay indirect; literal clues make scouting trivial.
- Ante's own source is not part of this repository: reuse design patterns only, never copy its code, and do not name or link Ante's private repositories or personal accounts here.
- No AI co-author trailers or session links in commits.

## Deploy

- The service is deployed by hand with `railway up --ci` from the repo root (it uses the `Dockerfile`). Railway is **not** connected to GitHub, so a push deploys nothing. Keep it that way.
- Service variables on Railway include the testnet settings and keys from `.env.testnet` and the analyst's model settings (`ANALYST_API_KEY`, `ANALYST_BASE_URL`, `ANALYST_MODELS`, `ANALYST_PROVIDER`, `ANALYST_DAILY_CAP`).
- Contract changes go to testnet through `scripts/testnet.ts`.

## What needs a human yes

- Any commit or push (the repo is public), and anything on `main` while judging is open.
- Any deploy, restart or variable change on Railway.
- Any testnet transaction that spends from the owner, settler or pot (including topping up the pot).
- Anything submitted to the hackathon: the submission form and the change-request form (https://nearhackathon.com/request-changes) are sent by a human.
- Any public post or message.
- Creating accounts, above all on mainnet. Never ask for or handle someone else's private key.

## Current state (2026-11-26)

- The entry was submitted by the owner on 2026-11-14. Development closed at 2026-11-14T23:59:00Z; `main` has stayed at `072cb28` since, and should stay there until judging is over.
- Branch `handoff-2026-11-26` (not merged) holds work done after the freeze: a dependency audit (npm `tar` overridden to 7.5.23; `url` 2.5.9 and `wasmtime` 36.0.23 in `contract/Cargo.lock`) and these agent docs. All tests and the e2e run pass on it. It is not deployed.
- Not patched: `time` 0.3.45 and `serde_with` 3.17.0 (the fixed versions need Rust 1.88), `lru` 0.16.4 and `opentelemetry_sdk` 0.30.0 (fixes are in versions NEAR's crates do not accept yet). `chrono`, `unsafe-libyaml` and `wee_alloc` are flagged as unmaintained only. Only `serde_with` and `wee_alloc` are in the compiled contract.
- Live state at the last check (2026-11-20 20:08 UTC): site up, analyst available, 18 runs, pot 2.5 NEAR at a 1 NEAR reward (2 more wins payable), settler account 0.497 NEAR for gas. A half-hourly health check ran from 2026-11-13 to 2026-11-20 and has ended; nothing monitors the site now.
- Open, waiting on the owner: top up the pot from the testnet faucet (it covers 2 more wins); whether to merge `handoff-2026-11-26` once judging is over.
- The analyst's model calls draw on a prepaid Surplus Intelligence balance shared with other Ante services ($19.89 on 2026-11-20). If the analyst stops answering, check that balance first.

## Only on the Mac

Nothing below is in git. Values are deliberately not recorded here.

- `.env.testnet` (repo root, git-ignored): `HEIST_CHAIN`, `NEAR_RPC_URL`, `HEIST_CONTRACT_ID`, `HEIST_MISSION_ID`, `HEIST_MISSION_SECRET`, `SETTLER_ACCOUNT_ID`, `SETTLER_PRIVATE_KEY`, `OWNER_ACCOUNT_ID`, `PLAYER_ACCOUNT_ID`, `PLAYER_PRIVATE_KEY`, `SCOUT_PRIVATE_KEY`, `CRYPTOGRAPHER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `HEIST_CONTRACT_PRIVATE_KEY`, `ANALYST_PRIVATE_KEY`. These are the only copies of the testnet keys outside Railway's variables; the mission secret is needed to reveal and close the mission.
- `.env.owner` (repo root, git-ignored): `OWNER_ACCOUNT_ID`, `OWNER_PRIVATE_KEY`. The owner key of the testnet account tree; it is not on Railway.
- `data/runs/` (git-ignored): local run records from development.
- The analyst's model API key: set on Railway as `ANALYST_API_KEY`; the only local copy sits in the `.env` of another, private Ante project on the Mac.
- CLI logins: GitHub CLI and git credentials for the organisation account that owns this repo; the Railway CLI login (expired on 2026-11-26, needs `railway login` before any deploy); `cargo-near` 0.20.3 and Rust 1.86 are installed locally.
- Running processes: none for this project on the Mac. The live game runs on Railway.
