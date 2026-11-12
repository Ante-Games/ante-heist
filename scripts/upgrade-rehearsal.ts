// Rehearses the in-place upgrade that adds the analyst, on a local sandbox, before it is done
// on testnet: deploys the wasm that is LIVE on testnet, makes state with it (a run with hires,
// settled), upgrades to the local build, and checks the old state still reads and the analyst
// can be set and hired.
//   node --env-file=.env.testnet scripts/upgrade-rehearsal.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Sandbox, DEFAULT_PRIVATE_KEY } from 'near-sandbox';
import { KeyPair, nearToYocto } from 'near-api-js';
import { near, TGAS, WASM } from './near-ops.ts';
import { sha256Hex } from '../game/src/heist.ts';

const live = process.env.HEIST_CONTRACT_ID!;
const liveRpc = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const res = await fetch(liveRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_code', finality: 'final', account_id: live } }) });
const code = Buffer.from(((await res.json()) as { result: { code_base64: string } }).result.code_base64, 'base64');
const fresh = readFileSync(WASM);
console.log(`live wasm on ${live}: ${code.length} bytes (${sha256Hex(code).slice(0, 12)}); local build: ${fresh.length} bytes (${sha256Hex(fresh).slice(0, 12)})`);

const sandbox = await Sandbox.start({});
try {
  const n = near(sandbox.rpcUrl);
  const owner = n.account('sandbox', DEFAULT_PRIVATE_KEY);
  const keys: Record<string, string> = {};
  for (const [p, amt] of Object.entries({ heist: '3', settler: '0.5', scout: '0.1', cryptographer: '0.1', operator: '0.1', analyst: '0.1', player: '3' })) {
    const kp = KeyPair.fromRandom('ed25519');
    await owner.createSubAccount({ accountOrPrefix: `${p}.sandbox`, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(amt) });
    keys[p] = kp.toString();
  }
  const c = 'heist.sandbox';
  const contract = n.account(c, keys.heist);
  const player = n.account('player.sandbox', keys.player);
  const settler = n.account('settler.sandbox', keys.settler);

  // 1. The live code, with state made the way testnet made it.
  await contract.deployContract(new Uint8Array(code));
  await contract.callFunction({ contractId: c, methodName: 'new', gas: TGAS(50), args: { owner: 'sandbox', settler: 'settler.sandbox', scout: 'scout.sandbox', cryptographer: 'cryptographer.sandbox', operator: 'operator.sandbox' } });
  await owner.callFunction({ contractId: c, methodName: 'fund_mission', gas: TGAS(30), deposit: nearToYocto('3'), args: { mission_id: 'mission-1', seed_hash: sha256Hex('s'), reward: nearToYocto('1').toString() } });
  const run0 = await player.callFunction<number>({ contractId: c, methodName: 'start_run', gas: TGAS(30), deposit: nearToYocto('0.01'), args: { mission_id: 'mission-1' } });
  for (const [npc, price] of [['scout', '0.25'], ['cryptographer', '0.4'], ['operator', '0.4']]) await player.callFunction({ contractId: c, methodName: 'hire', gas: TGAS(30), deposit: nearToYocto(price), args: { run_id: run0, npc } });
  await settler.callFunction({ contractId: c, methodName: 'settle_run', gas: TGAS(50), args: { run_id: run0, cleared: true } });
  const run1 = await player.callFunction<number>({ contractId: c, methodName: 'start_run', gas: TGAS(30), deposit: nearToYocto('0.01'), args: { mission_id: 'mission-1' } });
  await player.callFunction({ contractId: c, methodName: 'hire', gas: TGAS(30), deposit: nearToYocto('0.25'), args: { run_id: run1, npc: 'scout' } });
  await assert.rejects(player.callFunction({ contractId: c, methodName: 'hire', gas: TGAS(30), deposit: nearToYocto('0.1'), args: { run_id: run1, npc: 'analyst' } }), 'the live code has no analyst');
  const before = { run0: await n.view(c, 'get_run', { run_id: run0 }), run1: await n.view(c, 'get_run', { run_id: run1 }), mission: await n.view(c, 'get_mission', { mission_id: 'mission-1' }), scout: await n.view(c, 'get_npc', { npc: 'scout' }), count: await n.view(c, 'run_count') };

  // 2. Upgrade in place: same account, new code, no migration call.
  await contract.deployContract(new Uint8Array(fresh));
  const after = { run0: await n.view(c, 'get_run', { run_id: run0 }), run1: await n.view(c, 'get_run', { run_id: run1 }), mission: await n.view(c, 'get_mission', { mission_id: 'mission-1' }), scout: await n.view(c, 'get_npc', { npc: 'scout' }), count: await n.view(c, 'run_count') };
  assert.deepEqual(after, before, 'runs, hires, mission and NPCs read the same after the upgrade');
  console.log('state reads identically after the upgrade:', JSON.stringify(after.run0));

  // 3. The analyst: not hireable until the owner sets it, then paid like the others.
  await assert.rejects(player.callFunction({ contractId: c, methodName: 'hire', gas: TGAS(30), deposit: nearToYocto('0.1'), args: { run_id: run1, npc: 'analyst' } }), /not set up/);
  await assert.rejects(player.callFunction({ contractId: c, methodName: 'set_npc', gas: TGAS(30), args: { npc: 'analyst', account: 'player.sandbox', price: '1' } }), 'only the owner sets NPCs');
  await owner.callFunction({ contractId: c, methodName: 'set_npc', gas: TGAS(30), args: { npc: 'analyst', account: 'analyst.sandbox', price: nearToYocto('0.1').toString() } });
  const bal = await n.balance('analyst.sandbox');
  const idx = await player.callFunction<number>({ contractId: c, methodName: 'hire', gas: TGAS(30), deposit: nearToYocto('0.1'), args: { run_id: run1, npc: 'analyst' } });
  assert.equal(idx, 1);
  assert.equal((await n.balance('analyst.sandbox')) - bal, BigInt(nearToYocto('0.1')));
  // Old NPCs still work on a run opened before the upgrade, and it settles.
  await player.callFunction({ contractId: c, methodName: 'hire', gas: TGAS(30), deposit: nearToYocto('0.4'), args: { run_id: run1, npc: 'operator' } });
  await settler.callFunction({ contractId: c, methodName: 'settle_run', gas: TGAS(50), args: { run_id: run1, cleared: true } });
  const r1 = await n.view<{ hires: { npc: string }[]; outcome: string }>(c, 'get_run', { run_id: run1 });
  assert.deepEqual(r1.hires.map((h) => h.npc), ['scout', 'analyst', 'operator']);
  assert.equal(r1.outcome, 'Cleared');
  console.log('after upgrade:', JSON.stringify(r1));
  console.log('\nUPGRADE REHEARSAL OK');
} finally {
  await sandbox.tearDown();
}
