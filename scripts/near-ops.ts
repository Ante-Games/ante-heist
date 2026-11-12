// On-chain operations shared by the testnet CLI and the local sandbox end-to-end test.
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from 'near-api-js';
import { sha256Hex } from '../game/src/heist.ts';
import { NPC_PRICE_YOCTO, formatNear, type Npc } from '../game/src/rules.ts';
import { playScripted } from '../game/lead/scripted.ts';

export const WASM = 'contract/target/near/ante_heist_contract.wasm';
export const TGAS = (n: number) => BigInt(n) * 10n ** 12n;

export function near(rpcUrl: string) {
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const account = (id: string, key: string) => new Account(id, provider, key as `ed25519:${string}`);
  const view = <T = unknown>(contractId: string, method: string, args: Record<string, unknown> = {}) =>
    provider.callFunction({ contractId, method, args }) as Promise<T>;
  const balance = async (id: string) => BigInt((await provider.viewAccount({ accountId: id })).amount);
  const exists = async (id: string) => { try { await provider.viewAccount({ accountId: id }); return true; } catch { return false; } };
  return { provider, account, view, balance, exists };
}

export interface MissionEnv {
  HEIST_CHAIN: 'testnet';
  NEAR_RPC_URL: string;
  HEIST_CONTRACT_ID: string;
  HEIST_MISSION_ID: string;
  HEIST_MISSION_SECRET: string;
  SETTLER_ACCOUNT_ID: string;
  SETTLER_PRIVATE_KEY: string;
  OWNER_ACCOUNT_ID: string;
  PLAYER_ACCOUNT_ID: string;
  PLAYER_PRIVATE_KEY: string;
  SCOUT_PRIVATE_KEY: string;
  CRYPTOGRAPHER_PRIVATE_KEY: string;
  OPERATOR_PRIVATE_KEY: string;
  ANALYST_PRIVATE_KEY: string;
  HEIST_CONTRACT_PRIVATE_KEY: string;
}

// From one funded owner account: create sub-accounts, deploy + init the contract, fund a mission.
export async function setupMission(o: {
  rpcUrl: string; ownerId: string; ownerKey: string; potNear?: string; contractNear?: string; playerNear?: string; log?: (s: string) => void;
}): Promise<MissionEnv> {
  const log = o.log ?? console.log;
  const n = near(o.rpcUrl);
  const owner = n.account(o.ownerId, o.ownerKey);
  if (!existsSync(WASM)) throw new Error('build the contract first: cd contract && cargo near build non-reproducible-wasm');

  const fund: Record<string, string> = {
    heist: o.contractNear ?? '2', settler: '0.5', scout: '0.1', cryptographer: '0.1', operator: '0.1', analyst: '0.1', player: o.playerNear ?? '1.5',
  };
  const keys: Record<string, string> = {};
  for (const [prefix, amount] of Object.entries(fund)) {
    const id = `${prefix}.${o.ownerId}`;
    if (await n.exists(id)) throw new Error(`${id} already exists; use a fresh owner account`);
    const kp = KeyPair.fromRandom('ed25519');
    await owner.createSubAccount({ accountOrPrefix: id, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(amount) });
    keys[prefix] = kp.toString();
    log(`created ${id} (${amount} NEAR)`);
  }

  const contractId = `heist.${o.ownerId}`;
  const contract = n.account(contractId, keys.heist);
  await contract.deployContract(new Uint8Array(readFileSync(WASM)));
  await contract.callFunction({
    contractId, methodName: 'new', gas: TGAS(50),
    args: { owner: o.ownerId, settler: `settler.${o.ownerId}`, scout: `scout.${o.ownerId}`, cryptographer: `cryptographer.${o.ownerId}`, operator: `operator.${o.ownerId}` },
  });
  // The analyst is set after init: it is stored under its own key so older deployments can add it by upgrade.
  await owner.callFunction({
    contractId, methodName: 'set_npc', gas: TGAS(30),
    args: { npc: 'analyst', account: `analyst.${o.ownerId}`, price: NPC_PRICE_YOCTO.analyst.toString() },
  });
  log(`deployed and initialised ${contractId}`);

  const secret = randomBytes(32).toString('hex');
  const missionId = 'mission-1';
  const pot = o.potNear ?? '2';
  await owner.callFunction({
    contractId, methodName: 'fund_mission', gas: TGAS(30), deposit: nearToYocto(pot),
    args: { mission_id: missionId, seed_hash: sha256Hex(secret), reward: nearToYocto('1').toString() },
  });
  log(`funded ${missionId}: pot ${pot} NEAR, reward 1 NEAR, commitment ${sha256Hex(secret)}`);

  return {
    HEIST_CHAIN: 'testnet',
    NEAR_RPC_URL: o.rpcUrl,
    HEIST_CONTRACT_ID: contractId,
    HEIST_MISSION_ID: missionId,
    HEIST_MISSION_SECRET: secret,
    SETTLER_ACCOUNT_ID: `settler.${o.ownerId}`,
    SETTLER_PRIVATE_KEY: keys.settler,
    OWNER_ACCOUNT_ID: o.ownerId,
    PLAYER_ACCOUNT_ID: `player.${o.ownerId}`,
    PLAYER_PRIVATE_KEY: keys.player,
    SCOUT_PRIVATE_KEY: keys.scout,
    CRYPTOGRAPHER_PRIVATE_KEY: keys.cryptographer,
    OPERATOR_PRIVATE_KEY: keys.operator,
    ANALYST_PRIVATE_KEY: keys.analyst,
    HEIST_CONTRACT_PRIVATE_KEY: keys.heist,
  };
}

const PRICE: Record<string, string> = Object.fromEntries(Object.entries(NPC_PRICE_YOCTO).map(([k, v]) => [k, formatNear(v)]));

// The player's agent opens a run on chain, then plays; every hire is a real on-chain payment.
export async function playOnChain(o: {
  rpcUrl: string; base: string; contractId: string; missionId: string; playerId: string; playerKey: string;
  style: 'solo' | 'hire' | 'reckless'; log?: (s: string) => void;
}) {
  const log = o.log ?? console.log;
  const n = near(o.rpcUrl);
  const player = n.account(o.playerId, o.playerKey);
  const runId = await player.callFunction<number>({
    contractId: o.contractId, methodName: 'start_run', gas: TGAS(30), deposit: nearToYocto('0.01'), args: { mission_id: o.missionId },
  });
  log(`on chain: start_run → run_id ${runId}`);
  const pay = async (npc: Npc) => {
    const out = await player.callFunctionRaw({
      contractId: o.contractId, methodName: 'hire', gas: TGAS(30), deposit: nearToYocto(PRICE[npc]), args: { run_id: runId, npc },
    }) as { transaction: { hash: string }; status: { SuccessValue?: string } };
    const hireIndex = Number(Buffer.from(out.status.SuccessValue ?? '', 'base64').toString());
    log(`  on chain: hire(${npc}) paid ${PRICE[npc]} NEAR → hire #${hireIndex} (tx ${out.transaction.hash})`);
    return { hireIndex, tx: out.transaction.hash };
  };
  const { transcript } = await playScripted({ base: o.base, style: o.style, pay, start: { player: o.playerId, chainRunId: String(runId) }, log });
  const run = await n.view<{ outcome: string | null; reward_paid: string; hires: unknown[] }>(o.contractId, 'get_run', { run_id: runId });
  return { runId, transcript: transcript as { status: string; log: { kind: string; ok?: boolean; detail?: string }[]; settlement: { tx: string | null; explorer: string | null } | null }, run };
}
