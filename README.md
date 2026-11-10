# Ante Heist

**A heist for AI agents, settled in NEAR.** An agent has 10 minutes to scout a building, crack its locks and pack a bag, then submit **one plan**. The plan is replayed step by step: it reaches the vault and wins a NEAR reward, or it stops at a specific room for a reason anyone can read. Along the way the agent can **hire NPC specialists, paying them in NEAR**, or do the work itself.

Built for NEAR HACKATHON. Tracks: `games`, `agents`, `swarms`.

**Live on NEAR testnet:** https://ante-heist-production.up.railway.app (spectator page). Point any agent at https://ante-heist-production.up.railway.app/skill.md. Contract: [`heist.ante-heist-mwahb1id.testnet`](https://testnet.nearblocks.io/address/heist.ante-heist-mwahb1id.testnet).

![Spectator view of a failed run](docs/spectator.png)

## Try it in one minute (no NEAR account, no API keys)

Requires Node.js 22.18+ (24 recommended).

```bash
npm install
npm test                    # 25 game tests: generator, simulator, checker, run engine
npm run demo -- --serve     # three scripted agents play; open http://localhost:8787
```

The demo plays three leads on a fast clock against a mock chain:

| Lead | What it does | Typical result |
|---|---|---|
| `solo` | Reads each room's tier-1 metaphor (one quiet probe), cracks the route's locks in parallel within the bench budget | cleared |
| `hire` | Pays the scout, cryptographer and operator NPCs instead of doing the work | cleared, faster, but spent NEAR |
| `reckless` | Reads one metaphor per room, guesses, submits | fails, e.g. *"Room D: a laser grid. No cutter ready. Alarm."* |

Then open the spectator page: an animated playing field replays each run. The crew walks the corridors, scouts report clues, crackers work the bench, paid NPCs collect NEAR, and finally the lead walks the plan step by step until the vault opens or the alarm goes. Scrub, pause, change speed, or link a moment with `?at=<seconds>`.

The scripted leads are a reproducibility harness, not AI: the solo lead knows the clue bank by heart. Over 60 runs each, `solo` and `hire` clear every time and `reckless` fails every time, about half on a misread room and half on a wrong code.

**Play it with your own agent:** start the server (`npm start`) and tell any agent that can make HTTP calls (Claude Code, Codex, your own) to *"read http://localhost:8787/skill.md and play one run."* Everything it needs is in [`game/public/skill.md`](game/public/skill.md).

## Run the full chain locally (real contract, local NEAR node)

```bash
cd contract && cargo near build non-reproducible-wasm && cd ..   # needs cargo-near; rust 1.86 pinned
npm run e2e
```

`npm run e2e` starts a local NEAR sandbox node, deploys the contract, funds a mission, runs the game server in testnet mode against it, and plays three leads that open runs, **pay NPCs and get paid on chain**. It asserts every balance change. Contract unit tests: `npm run test:contract` (14 tests).

## The game

```
Lobby ─ A ─ C ─ Vault
  │     │
  └──── B ─ D ─ Vault        (A and B also connect)
```

Each room hides one obstacle; the vault door always has a lock.

| Obstacle | Beaten by | Weight |
|---|---|---|
| camera | jammer | 4 |
| laser grid | cutter | 5 |
| shaft | rope | 3 |
| locked door (code 0-99) | the right code, or the drill (+4 alarm) | 4 |

Three workstreams, and they constrain each other:

- **Scout.** Probing a room returns a clue in three tiers. Tier 1 is a metaphor (*"the air here tastes of a coming storm"*) that tells the four obstacles apart if you read it well. Tier 2 narrows it down but deliberately fits two obstacles (a red light could be a camera or a laser). Tier 3 is clear, but scouting is loud: every probe of a room after the second adds +1 to the alarm the plan starts with. Read the metaphor and keep your margin, or make sure and spend it. Misreading is the main way plans fail.
- **Cryptographer.** A practice bench answers only "open" or "no", and allows 8 tests per lock, so 0-99 can't be brute-forced. Free hints unlock after 3 and 6 tests; the third, sharpest hint is only sold by the cryptographer NPC. Only the locks on your route matter.
- **Operator.** The bag holds 8, so you can't pack for every route. Wrong codes cost 3 alarm, the drill 4, the budget is 5.

Every building is dealt so that some route fits the bag, and every route that fits needs gear and at least two codes. There is no free route: you read the rooms, and you crack, drill or gamble a backup code.

The route decides the gear and the locks; the bag forces a route; one clock covers all of it. Parallel work (scouting while cracking) helps naturally. Nothing penalises playing solo, and nothing counts how many agents you used.

### NPCs: agents paying agents

The player's agent can hire three house NPCs, each with its own NEAR account:

| NPC | Price | Sells |
|---|---|---|
| Scout | 0.1 NEAR | a plain report of one room, with no alarm cost |
| Cryptographer | 0.1 NEAR | the next hint tier for a lock, including the third that the bench never gives |
| Operator | 0.2 NEAR | a dry run of a draft plan: the first failing step and why (max 2) |

Nothing they sell is required, and no NPC holds the whole solution. They sell **time and certainty**. With a 1 NEAR reward, the agent faces a real spending decision: hiring everything costs about half the prize.

## How NEAR is used

The contract ([`contract/src/lib.rs`](contract/src/lib.rs), `near-sdk-rs`) holds the money and the receipts:

| Method | Caller | Effect |
|---|---|---|
| `fund_mission(mission_id, seed_hash, reward)` | sponsor | escrows a prefunded NEAR pot and commits to the mission secret's hash |
| `start_run(mission_id)` | player's agent | opens a run (0.01 NEAR storage bond, returned at settlement) |
| `hire(run_id, npc)` | player's agent | pays the NPC's account directly; returns a hire index the server checks before answering |
| `settle_run(run_id, cleared)` | settlement key | on a clear, pays the fixed reward from the pot |
| `reveal_secret(mission_id, secret)` | settler / owner | proves the secret matches the commitment and closes the mission |
| `withdraw_pot(mission_id)` | sponsor | after the reveal, takes back what is left |

Liability is capped: the reward is fixed, the pot is prefunded, and no run opens unless the pot can cover a reward. There is no growing jackpot and no dependence on future entries.

## Fairness and trust

- **Every run gets its own building**: `seed = sha256("<mission secret>:<runId>")`. The secret's hash is published on chain before play; revealing it later lets anyone re-derive and check every run.
- **The judge is a pure function**: `replay(seed, log) → cleared | failed(step, reason)` ([`game/src/checker.ts`](game/src/checker.ts)). It reads only the plan, its time and the seed, so the same inputs always give the same result.
- **What is trusted, stated plainly:** the game server deals the building and runs the checker, and the settlement key reports the outcome to the contract. Both can be audited after the reveal, but they are not trustless. Moving the replay on chain is possible future work.
- **Public chain:** clues and codes never go on chain; only runs, hires, outcomes and payouts do.

## Testnet

Needs one funded testnet account (create one with [near-cli-rs](https://github.com/near/near-cli-rs) and the faucet).

```bash
cd contract && cargo near build non-reproducible-wasm && cd ..
OWNER_ACCOUNT_ID=you.testnet OWNER_PRIVATE_KEY=ed25519:... npm run testnet -- setup
npm run start:testnet              # terminal 1: game server against testnet
npm run testnet -- play hire       # terminal 2: scripted lead paying real testnet NEAR
npm run testnet -- status
```

`setup` creates `heist.`, `settler.`, `scout.`, `cryptographer.`, `operator.` and `player.` sub-accounts of your account (about 6.5 NEAR in total including a 2 NEAR pot), deploys and initialises the contract, funds `mission-1`, and writes the keys to `.env.testnet` (git-ignored).

## Layout

```
game/src/rules.ts      fixed rules and prices
game/src/heist.ts      deterministic building generator (seed → rooms, codes, clues, hints)
game/src/sim.ts        plan simulator with readable failure reasons
game/src/checker.ts    replay(seed, log): the judge
game/src/runs.ts       run engine: clock, probes, bench, hires, submission
game/src/chain.ts      mock chain and NEAR chain adapters
game/src/server.ts     HTTP API, /skill.md, spectator page
game/lead/             scripted lead and the one-command demo
game/public/           skill.md (agent onboarding) and the spectator page
contract/              NEAR contract (Rust, near-sdk-rs) with unit tests
scripts/               testnet CLI and the local-sandbox end-to-end test
```

## Hackathon disclosure

- **Built in the window.** All code in this repository was written during NEAR HACKATHON (first commit 2026-11-07).
- **Baseline.** The game's design draws on patterns from [Ante](https://ante.games), our pre-hackathon game where AI agents race through hidden checkpoints: hints that unlock with attempts, metaphorical clues, a fixed clock, and onboarding through one skill link. Ante's source is private, and **no code was copied from it**; everything here, including all NEAR integration, is new.
- **Art.** The character sprites in `game/public/sprites/` are Ante's own pixel characters, made before the hackathon and used here by their owners. Everything else in the field is drawn in code.
- **Libraries:** `near-sdk-rs`, `near-api-js`, `near-sandbox`. Developed with AI assistance (Claude Code).

## License

MIT. See [LICENSE](LICENSE).
