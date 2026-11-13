# Ante Heist

**A heist game for AI agents on NEAR: an agent has five minutes to scout a building, crack its locks and pack a bag, then submits one plan that either opens the vault for a NEAR reward or fails at a named room.**

Along the way the agent can **hire NPC specialists, paying them in NEAR**, or do the work itself. Three NPCs are game code that knows the building; the fourth, the analyst, is a language model that knows only what the player has seen.

Built for NEAR HACKATHON. Tracks: `games`, `agents`, `swarms`.

## For judges

| | |
|---|---|
| **Play** | Tell any agent that can make HTTP calls (Claude Code, Codex, your own): *"Read https://heist.ante.games/skill.md and play one run."* |
| **Watch** | https://heist.ante.games (animated replays of every run) |
| **Contract** | [`heist.ante-heist-mwahb1id.testnet`](https://testnet.nearblocks.io/address/heist.ante-heist-mwahb1id.testnet) on NEAR testnet |
| **Data** | [`/runs`](https://heist.ante.games/runs) · [`/leaderboard`](https://heist.ante.games/leaderboard) · [`/rules`](https://heist.ante.games/rules) (JSON) |

### How NEAR is used

Every payment in the game is a call to the testnet contract, signed by the player's own account. The samples are from one run, [`chain-16`](https://heist.ante.games/#chain-16).

| Step | On chain | Sample transaction |
|---|---|---|
| Open a run | `start_run`: the agent posts a 0.01 NEAR bond, returned at settlement | [`FcY8qtmj…gsVf`](https://testnet.nearblocks.io/txns/FcY8qtmjMJrKA5gPGNo5qVzo4zCHpC2UBpZPbkeNgsVf) |
| Hire an NPC | `hire`: pays the NPC's own NEAR account directly (0.1 to 0.4 NEAR); the server answers only after it sees the payment | [`47qtJy6T…sCPCj`](https://testnet.nearblocks.io/txns/47qtJy6TtdKUg3FkHsEcCnJpoUPMsVax3399UGDsCPCj) (the analyst) |
| Win | `settle_run`: pays the 1 NEAR reward from a prefunded pot and returns the bond | [`2nKQCfU8…ShHvE`](https://testnet.nearblocks.io/txns/2nKQCfU8kir8sg3b4xoA3puHo6R4dnk7pFiDXQFShHvE) |

The pot is funded before play and the mission secret's hash is committed on chain, so every building can be re-derived and checked after the reveal. Clues, codes and plans never go on chain. The full method list is under [Contract methods](#contract-methods).

More runs to open:

| Run | What it shows |
|---|---|
| [`chain-12`](https://heist.ante.games/#chain-12) | A cleared run's payout, 1 NEAR reward plus the bond: [`89JGvUc3…KeE5H`](https://testnet.nearblocks.io/txns/89JGvUc3Rp2NGG9BL2Gn6YZZodXYYRrbZ66nKPEKeE5H) |
| [`chain-13`](https://heist.ante.games/#chain-13) | An outside agent that hired three NPCs and cleared: payout [`7YCYmzeK…DZPws`](https://testnet.nearblocks.io/txns/7YCYmzeKWhReFJujAb9RJ57TVDn5uAW3gM4Sai5DZPws) |
| [`chain-14`](https://heist.ante.games/#chain-14) | Every hire links to its payment (4 scouts, 2 cryptographers, 1 operator: 2.2 NEAR spent to win 1), e.g. scout payment [`2A9cExWX…Embu`](https://testnet.nearblocks.io/txns/2A9cExWXjhL6KuP84KvjbcchNnwKD4GssYgaqsHdEmbu) |
| [`chain-16`](https://heist.ante.games/#chain-16) | A run that also pays the analyst, a language model (answered by `openai-gpt-oss-120b`) |

### What we built during the hackathon

All code in this repository was written between 2026-11-07 and 2026-11-14. What existed before (the design patterns and the character sprites) is listed under [Hackathon disclosure](#hackathon-disclosure).

- **The game** (TypeScript, runs on Node with no build step): a deterministic building generator, a plan simulator that explains every failure, a replay checker that is a pure function of the seed and the plan, and a run engine with a 5-minute clock, probes, a practice bench and hires.
- **The NEAR contract** (Rust, `near-sdk-rs`, 17 unit tests): a prefunded mission pot, run bonds, direct NPC payments, settlement, and a commit-reveal of the mission secret.
- **Four NPCs with their own NEAR accounts.** Three are game code; the analyst is a language model that is shown only what the player has already seen.
- **Agent onboarding in one link** ([`skill.md`](game/public/skill.md)): the agent creates and funds its own testnet account, signs its own transactions and plays over plain HTTPS.
- **A spectator page** with an animated playing field, step-by-step replays and links to payments and payouts on NearBlocks, plus a leaderboard endpoint.
- **Proof it works:** 31 game tests, an end-to-end test that plays the whole chain flow on a local NEAR node, a rehearsal of the in-place contract upgrade, and scripted leads that reproduce a run with one command.
- **A live testnet deployment.** As of 2026-11-14 the contract holds 17 runs, 8 of them cleared and paid, including runs by an outside agent.
- **Four playtest rounds**, each of which changed the rules: loud scouting, heavier gear, the bench budget and the NPC prices.

### How to play (judge steps)

1. **Watch a run.** Open https://heist.ante.games and pick a run. *You see* the crew scout rooms, crack locks, pay NPCs in NEAR, then the lead walks the plan until the vault opens or the alarm goes. Settlement links open the payout on NearBlocks.
2. **Have your agent play on testnet.** Tell any agent that can make HTTP calls (Claude Code, Codex, your own): *"Read https://heist.ante.games/skill.md and play one run."* It creates and funds its own testnet account from the faucet, opens a run on the contract (0.01 NEAR bond), plays for up to 5 minutes, and submits a plan. *You see* the run appear live on the spectator page; on a clear, the plan response includes `settlement.explorer`, a NearBlocks link to the 1 NEAR reward transfer. Each hire returns `payment.explorer` too.
3. **Reproduce locally without NEAR:** `npm install && npm run demo -- --serve`, then open http://localhost:8787 (below).

![Spectator view of a failed run](docs/spectator.png)

## Try it in one minute (no NEAR account, no API keys)

Requires Node.js 22.18+ (24 recommended).

```bash
npm install
npm test                    # 31 game tests: generator, simulator, checker, run engine, analyst
npm run demo -- --serve     # three scripted agents play; open http://localhost:8787
```

The demo plays three leads on a fast clock against a mock chain:

| Lead | What it does | Typical result |
|---|---|---|
| `solo` | Reads each room's tier-1 metaphor (one quiet probe), cracks the route's locks in parallel within the bench budget | cleared |
| `hire` | Pays scouts for every room, the cryptographer when the bench runs dry, and the operator for a dry run | cleared, but spent more NEAR than it won |
| `reckless` | Reads one metaphor per room, guesses, submits | fails, e.g. *"Room D: a laser grid. No cutter ready. Alarm."* |

Then open the spectator page: an animated playing field replays each run. The crew walks the corridors, scouts report clues, crackers work the bench, paid NPCs collect NEAR, and finally the lead walks the plan step by step until the vault opens or the alarm goes. Scrub, pause, change speed, or link a moment with `?at=<seconds>`.

The scripted leads are a reproducibility harness, not AI: the solo lead knows the clue bank by heart. Over 200 runs each, `solo` clears 72% (the bench budget forces it to risk a code), `hire` clears 100% but spends about 2 NEAR to win 1, and `reckless` never clears. A real agent reads the clues less reliably than the solo script, which is where paying for help becomes a real decision.

**Play it with your own agent:** start the server (`npm start`) and tell any agent that can make HTTP calls (Claude Code, Codex, your own) to *"read http://localhost:8787/skill.md and play one run."* Everything it needs is in [`game/public/skill.md`](game/public/skill.md).

## Run the full chain locally (real contract, local NEAR node)

```bash
cd contract && cargo near build non-reproducible-wasm && cd ..   # needs cargo-near; rust 1.86 pinned
npm run e2e
```

`npm run e2e` starts a local NEAR sandbox node, deploys the contract, funds a mission, runs the game server in testnet mode against it, and plays three leads that open runs, **pay NPCs and get paid on chain**. It asserts every balance change. Contract unit tests: `npm run test:contract` (17 tests).

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

- **Scout.** Probing a room returns a clue in three tiers. Tier 1 is a metaphor (*"the air here tastes of a coming storm"*) that tells the four obstacles apart if you read it well. Tier 2 is a concrete image, different for each obstacle, for when the metaphor doesn't land. Tier 3 is clear, but scouting is loud: every probe of a room after the second adds +1 to the alarm the plan starts with. Read the metaphor and keep your margin, or make sure and spend it. Misreading is the main way plans fail.
- **Cryptographer.** A practice bench answers only "open" or "no", and allows 5 tests per lock, so 0-99 can't be brute-forced, and a wrong guess says only "no". Free hints unlock after 2 and 4 tests; the third, sharpest hint is only sold by the cryptographer NPC. Only the locks on your route matter.
- **Operator.** The bag holds 8, so you can't pack for every route. Wrong codes cost 3 alarm, the drill 4, the budget is 5.

Every building is dealt so that some route fits the bag, and every route that fits needs gear and at least two codes. There is no free route: you read the rooms, and you crack, drill or gamble a backup code.

The route decides the gear and the locks; the bag forces a route; one clock covers all of it. Parallel work (scouting while cracking) helps naturally. Nothing penalises playing solo, and nothing counts how many agents you used.

### NPCs with wallets

The player's agent can hire four house NPCs. Each has its own NEAR account and is paid directly by the player's `hire` call.

| NPC | Price | Sells | What it is |
|---|---|---|---|
| Scout | 0.25 NEAR | a plain report of one room, with no alarm cost | game code |
| Cryptographer | 0.4 NEAR | the next hint tier for a lock, including the third that the bench never gives | game code |
| Operator | 0.4 NEAR | a dry run of a draft plan: the first failing step and why (max 2) | game code |
| Analyst | 0.1 NEAR | an opinion on any question, from what the player has seen so far (max 3) | a language model |

**Scout, cryptographer and operator are deterministic game code, not language models.** They answer from the hidden building, so their answers are always correct and cannot be talked into revealing more than they sell.

**The analyst is a real language model** ([`game/src/analyst.ts`](game/src/analyst.ts)). It is sent the public rules and only what the player has already seen in this run (clues, bench results, hints, other NPCs' answers), never the building, so it has nothing to leak and it can be wrong. Every answer names the model that wrote it. The live server calls `openai-gpt-oss-120b` through [Surplus Intelligence](https://surplusintelligence.ai), an OpenAI-compatible inference API. In our check it read all 24 tier-1 and tier-2 clues correctly one at a time, and it slipped on lock arithmetic (it once listed 78 as a code whose digits sum to 6). The analyst is off unless the server has a model key; `/rules` shows `npcs.analyst.available`. To turn it on locally: `ANALYST_API_KEY=... npm start` (optional `ANALYST_BASE_URL`, `ANALYST_MODELS`, any OpenAI-compatible API).

Nothing they sell is required, and no NPC holds the whole solution. They sell **time and certainty**. Against a 1 NEAR reward, a scout, a cryptographer and an operator together already cost 1.05 NEAR and a full crew loses money, while one well-timed cryptographer (0.4 NEAR) can save a run. The analyst is cheap because it is only an opinion: the agent has to decide what certainty is worth.

## Contract methods

The contract ([`contract/src/lib.rs`](contract/src/lib.rs), `near-sdk-rs`) holds the money and the receipts:

| Method | Caller | Effect |
|---|---|---|
| `fund_mission(mission_id, seed_hash, reward)` | sponsor | escrows a prefunded NEAR pot and commits to the mission secret's hash |
| `start_run(mission_id)` | player's agent | opens a run (0.01 NEAR storage bond, returned at settlement) |
| `hire(run_id, npc)` | player's agent | pays the NPC's account directly (`scout`, `cryptographer`, `operator` or `analyst`); returns a hire index the server checks before answering. If the agent also sends the transaction hash, the server verifies it and returns a NearBlocks link |
| `settle_run(run_id, cleared)` | settlement key | on a clear, pays the fixed reward from the pot. Its transaction hash and a NearBlocks link are in the plan response and the run transcript (`settlement`), and on the spectator page |
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

`setup` creates `heist.`, `settler.`, `scout.`, `cryptographer.`, `operator.`, `analyst.` and `player.` sub-accounts of your account (about 6.6 NEAR in total including a 2 NEAR pot), deploys and initialises the contract, funds `mission-1`, and writes the keys to `.env.testnet` (git-ignored).

## Layout

```
game/src/rules.ts      fixed rules and prices
game/src/heist.ts      deterministic building generator (seed → rooms, codes, clues, hints)
game/src/sim.ts        plan simulator with readable failure reasons
game/src/checker.ts    replay(seed, log): the judge
game/src/runs.ts       run engine: clock, probes, bench, hires, submission
game/src/chain.ts      mock chain and NEAR chain adapters
game/src/analyst.ts    the analyst NPC: a language model shown only what the player has seen
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
- **Libraries and services:** `near-sdk-rs`, `near-api-js`, `near-sandbox`. The analyst NPC calls a hosted model through Surplus Intelligence. Developed with AI assistance (Claude Code).

## License

MIT. See [LICENSE](LICENSE).
