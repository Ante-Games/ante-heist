// Owner-only, for a contract deployed before the analyst existed: upgrades the code in place
// (no migration; rehearsed by scripts/upgrade-rehearsal.ts), creates analyst.<owner> if it is
// missing, and sets the analyst's account and price on chain.
// Usage: node --env-file=.env.testnet --env-file=.env.owner scripts/add-analyst.ts
import { readFileSync, appendFileSync } from 'node:fs';
import { KeyPair, nearToYocto } from 'near-api-js';
import { near, TGAS, WASM } from './near-ops.ts';
import { NPC_PRICE_YOCTO, formatNear } from '../game/src/rules.ts';
import { sha256Hex } from '../game/src/heist.ts';

const n = near(process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com');
const contractId = process.env.HEIST_CONTRACT_ID!;
const missionId = process.env.HEIST_MISSION_ID!;
const ownerId = process.env.OWNER_ACCOUNT_ID!;
const owner = n.account(ownerId, process.env.OWNER_PRIVATE_KEY!);
const analystId = `analyst.${ownerId}`;

// What must read the same before and after: the mission, the run count and the latest run.
const snapshot = async () => {
  const runs = await n.view<number>(contractId, 'run_count');
  return JSON.stringify({
    runs,
    mission: await n.view(contractId, 'get_mission', { mission_id: missionId }),
    lastRun: runs > 0 ? await n.view(contractId, 'get_run', { run_id: runs - 1 }) : null,
    scout: await n.view(contractId, 'get_npc', { npc: 'scout' }),
  });
};

const before = await snapshot();
const wasm = readFileSync(WASM);
await n.account(contractId, process.env.HEIST_CONTRACT_PRIVATE_KEY!).deployContract(new Uint8Array(wasm));
console.log(`upgraded ${contractId} to build ${sha256Hex(wasm).slice(0, 12)} (${wasm.length} bytes)`);
if ((await snapshot()) !== before) throw new Error('state reads differently after the upgrade: stop and investigate');
console.log(`state unchanged: ${before}`);

if (!(await n.exists(analystId))) {
  const kp = KeyPair.fromRandom('ed25519');
  await owner.createSubAccount({ accountOrPrefix: analystId, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto('0.1') });
  appendFileSync('.env.testnet', `ANALYST_PRIVATE_KEY=${kp.toString()}\n`);
  console.log(`created ${analystId} (0.1 NEAR); its key was appended to .env.testnet`);
}
const set = await owner.callFunctionRaw({
  contractId, methodName: 'set_npc', gas: TGAS(30),
  args: { npc: 'analyst', account: analystId, price: NPC_PRICE_YOCTO.analyst.toString() },
}) as { transaction: { hash: string } };
console.log(`analyst set: ${analystId} at ${formatNear(NPC_PRICE_YOCTO.analyst)} NEAR, tx ${set.transaction.hash}`);
console.log('get_npc(analyst):', JSON.stringify(await n.view(contractId, 'get_npc', { npc: 'analyst' })));
