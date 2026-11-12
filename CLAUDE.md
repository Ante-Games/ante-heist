# Ante Heist

NEAR HACKATHON entry. Development ends 2026-11-14T23:59:00Z; the repo must be public by then (a human decision). Rules: https://nearhackathon.com/HACKATHON.md

- Game: TypeScript run directly by Node 24 (type stripping: no enums, namespaces or constructor parameter properties). No build step. `npm test`, `npm run demo -- --serve`.
- Contract: Rust `near-sdk-rs`, pinned to Rust 1.86 (`contract/rust-toolchain.toml`) because newer rustc emits wasm the NEAR VM rejects with this SDK. Build with `cargo near build non-reproducible-wasm` (cargo-near 0.20.3). `npm run test:contract`.
- `npm run e2e` runs the whole chain flow on a local NEAR sandbox. Run it after any change to the contract, `chain.ts` or `near-ops.ts`.
- The checker (`game/src/checker.ts`) must stay a pure function of (seed, log). Never score agent count.
- Clue text (`game/src/content.ts`): every obstacle has its own clue at every tier (no shared clues), but tiers 1-2 must stay indirect; literal clues make scouting trivial.

Never commit `.env.testnet` (private keys and the mission secret). This repo is pushed as the Ante-Games GitHub account; a repo-local credential helper handles that. Ante's own source is private: reuse design patterns only, never copy its code, and never name or link its repositories or the GitHub account hosting them. Before every push, grep for those names.
