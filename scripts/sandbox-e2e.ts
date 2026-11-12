// End-to-end test on a local NEAR sandbox node: deploys the real contract, runs the real game
// server in testnet mode against it, and plays leads that pay NPCs and get paid on chain.
//   npm run e2e
import assert from 'node:assert/strict';
import { NPC_PRICE_YOCTO } from '../game/src/rules.ts';
import { Sandbox, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { setupMission, playOnChain, near } from './near-ops.ts';
import { Runs } from '../game/src/runs.ts';
import { TestnetChain } from '../game/src/chain.ts';
import { makeServer } from '../game/src/server.ts';

const ONE = 10n ** 24n;
const sandbox = await Sandbox.start({});
const server = { close: () => {} } as { close: () => void };
try {
  const rpcUrl = sandbox.rpcUrl;
  console.log(`sandbox at ${rpcUrl}`);
  const env = await setupMission({ rpcUrl, ownerId: 'sandbox', ownerKey: DEFAULT_PRIVATE_KEY, potNear: '3', playerNear: '5' });
  const n = near(rpcUrl);

  const chain = new TestnetChain(rpcUrl, env.HEIST_CONTRACT_ID, env.HEIST_MISSION_ID, env.SETTLER_ACCOUNT_ID, env.SETTLER_PRIVATE_KEY);
  const runs = new Runs({ missionSecret: env.HEIST_MISSION_SECRET, chain, timeScale: 0, dataDir: null });
  const http = makeServer(runs, chain);
  await new Promise<void>((r) => http.listen(0, r));
  server.close = () => http.close();
  const base = `http://localhost:${(http.address() as { port: number }).port}`;

  const npcBefore = await Promise.all(['scout', 'cryptographer', 'operator'].map((p) => n.balance(`${p}.sandbox`)));
  const playerBefore = await n.balance(env.PLAYER_ACCOUNT_ID);
  const play = (style: 'hire' | 'solo' | 'reckless') => playOnChain({
    rpcUrl, base, contractId: env.HEIST_CONTRACT_ID, missionId: env.HEIST_MISSION_ID,
    playerId: env.PLAYER_ACCOUNT_ID, playerKey: env.PLAYER_PRIVATE_KEY, style,
  });

  // 1. A lead that hires every NPC and clears.
  const hire = await play('hire');
  assert.equal(hire.transcript.status, 'cleared');
  assert.equal(hire.run.outcome, 'Cleared');
  assert.equal(BigInt(hire.run.reward_paid), ONE);
  assert.ok(hire.transcript.log.some((e) => e.kind === 'settle' && e.ok), 'settlement recorded');

  const npcAfter = await Promise.all(['scout', 'cryptographer', 'operator'].map((p) => n.balance(`${p}.sandbox`)));
  const gained = npcAfter.map((b, i) => b - npcBefore[i]);
  const P = NPC_PRICE_YOCTO;
  assert.equal(gained[0], 4n * P.scout, 'scout paid for 4 rooms');
  assert.equal(gained[1] % P.cryptographer, 0n, 'cryptographer paid whole hires');
  assert.equal(gained[2], P.operator, 'operator paid for one dry run');
  const hires = hire.transcript.log.filter((e) => e.kind === 'hire') as { tx?: string; explorer?: string }[];
  assert.ok(hires.length > 0 && hires.every((h) => h.tx && h.explorer?.includes(h.tx)), 'every hire carries its checked tx hash and explorer link');
  const tx = hire.transcript.settlement;
  assert.ok(tx?.tx && tx.explorer?.includes(tx.tx), 'settlement tx hash and explorer link recorded');

  // 2. A hire can't be spent twice, and a chain run can't be reused for a second heist.
  await assert.rejects(fetch(`${base}/runs`, { method: 'POST', body: JSON.stringify({ player: env.PLAYER_ACCOUNT_ID, chainRunId: String(hire.runId) }) })
    .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); }));

  // 3. A solo lead plays without hiring and a reckless lead guesses; the chain matches the server either way.
  const solo = await play('solo');
  assert.equal(solo.run.outcome, solo.transcript.status === 'cleared' ? 'Cleared' : 'Failed');
  const reckless = await play('reckless');
  assert.equal(reckless.run.outcome, reckless.transcript.status === 'cleared' ? 'Cleared' : 'Failed');

  // 4. Once the pot can't cover a reward, no new runs open.
  const left = await n.view<{ pot: string }>(env.HEIST_CONTRACT_ID, 'get_mission', { mission_id: env.HEIST_MISSION_ID });
  if (BigInt(left.pot) < ONE) await assert.rejects(play('solo'), /pot cannot cover/);

  const mission = await n.view<{ pot: string; runs: number; clears: number }>(env.HEIST_CONTRACT_ID, 'get_mission', { mission_id: env.HEIST_MISSION_ID });
  console.log('\nmission after 3 runs:', mission);
  const playerAfter = await n.balance(env.PLAYER_ACCOUNT_ID);
  console.log(`player net: ${Number(playerAfter - playerBefore) / 1e24} NEAR (rewards minus hires and gas)`);
  console.log('\nE2E OK: contract deployed, hires paid NPCs on chain, clears paid rewards, settlement verified.');
} finally {
  server.close();
  await sandbox.tearDown();
}
