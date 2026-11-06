import { NPC_PRICE_YOCTO, REWARD_YOCTO, formatNear, type Npc } from './rules.ts';

export interface StartCheck { ok: boolean; player: string | null; error?: string }
export interface HireCheck { ok: boolean; receipt: string; error?: string }
export interface SettleResult { ok: boolean; detail: string }

// What the game server needs from the chain. The server never moves funds itself except
// through `settle`, which only the settlement key can call on the contract.
export interface Chain {
  mode: 'mock' | 'testnet';
  describe(): Record<string, unknown>;
  checkStart(chainRunId: string | null, player: string | null): Promise<StartCheck>;
  checkHire(chainRunId: string | null, npc: Npc, payment: unknown, used: Set<string>): Promise<HireCheck>;
  settle(chainRunId: string | null, cleared: boolean): Promise<SettleResult>;
}

const NPC_ENUM: Record<Npc, string> = { scout: 'Scout', cryptographer: 'Cryptographer', operator: 'Operator' };

// Local play with no NEAR account. Hires are accepted with {"mock": true} and nothing is paid.
export class MockChain implements Chain {
  mode = 'mock' as const;
  private n = 0;
  describe() {
    return {
      mode: this.mode,
      note: 'Mock chain: hires are free and settlement is simulated. Set HEIST_CHAIN=testnet for real testnet NEAR.',
      reward: `${formatNear(REWARD_YOCTO)} NEAR`,
      prices: Object.fromEntries(Object.entries(NPC_PRICE_YOCTO).map(([k, v]) => [k, `${formatNear(v)} NEAR`])),
    };
  }
  async checkStart(_chainRunId: string | null, player: string | null): Promise<StartCheck> {
    return { ok: true, player };
  }
  async checkHire(_id: string | null, npc: Npc, payment: unknown): Promise<HireCheck> {
    if (!payment || typeof payment !== 'object' || (payment as { mock?: unknown }).mock !== true) {
      return { ok: false, receipt: '', error: 'mock chain: send "payment": {"mock": true}' };
    }
    return { ok: true, receipt: `mock-hire-${++this.n}-${npc}` };
  }
  async settle(_id: string | null, cleared: boolean): Promise<SettleResult> {
    return { ok: true, detail: cleared ? `mock: would pay ${formatNear(REWARD_YOCTO)} NEAR to the player` : 'mock: reward withheld' };
  }
}

interface ChainHire { npc: string; paid: string }
interface ChainRun { mission_id: string; player: string; hires: ChainHire[]; outcome: string | null }

// NEAR testnet. Players call `start_run` and `hire` on the contract themselves, from their own
// account; the server only reads the contract and calls `settle_run` with the settlement key.
export class TestnetChain implements Chain {
  mode = 'testnet' as const;
  private settler: Promise<{ callFunction: (a: Record<string, unknown>) => Promise<unknown> }> | null = null;
  private rpcUrl: string;
  private contractId: string;
  private missionId: string;
  private settlerId: string | null;
  private settlerKey: string | null;

  constructor(rpcUrl: string, contractId: string, missionId: string, settlerId: string | null, settlerKey: string | null) {
    this.rpcUrl = rpcUrl;
    this.contractId = contractId;
    this.missionId = missionId;
    this.settlerId = settlerId;
    this.settlerKey = settlerKey;
  }

  describe() {
    return {
      mode: this.mode,
      network: 'testnet',
      contract: this.contractId,
      mission: this.missionId,
      howTo: [
        `call ${this.contractId}.start_run({"mission_id":"${this.missionId}"}) from your account; it returns your run_id`,
        `POST /runs with {"player":"<your account>","chainRunId":"<run_id>"}`,
        `to hire: call ${this.contractId}.hire({"run_id":<run_id>,"npc":"Scout|Cryptographer|Operator"}) with the price attached, then POST the hire with {"payment":{"hireIndex":<index it returned>}}`,
      ],
    };
  }

  private async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'heist', method: 'query',
        params: { request_type: 'call_function', finality: 'optimistic', account_id: this.contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') },
      }),
    });
    const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
    if (body.error) throw new Error(`rpc: ${body.error.message ?? 'error'} ${JSON.stringify(body.error.data ?? '')}`);
    if (!body.result?.result) throw new Error(`rpc: ${body.result?.error ?? 'empty result'}`);
    return JSON.parse(Buffer.from(body.result.result).toString('utf8')) as T;
  }

  // A transaction the player just sent can take a block or two to show up; retry briefly.
  private async getRun(chainRunId: string, ready: (r: ChainRun | null) => boolean = (r) => r !== null): Promise<ChainRun | null> {
    let run: ChainRun | null = null;
    for (let i = 0; i < 8; i++) {
      run = await this.view<ChainRun | null>('get_run', { run_id: Number(chainRunId) });
      if (ready(run)) return run;
      await new Promise((r) => setTimeout(r, 750));
    }
    return run;
  }

  async checkStart(chainRunId: string | null, player: string | null): Promise<StartCheck> {
    if (!chainRunId || !/^\d+$/.test(chainRunId)) return { ok: false, player, error: 'testnet: "chainRunId" (the run_id from start_run) is required' };
    if (!player) return { ok: false, player, error: 'testnet: "player" (your NEAR account) is required' };
    const run = await this.getRun(chainRunId);
    if (!run) return { ok: false, player, error: `no run ${chainRunId} on ${this.contractId}` };
    if (run.player !== player) return { ok: false, player, error: `run ${chainRunId} belongs to ${run.player}, not ${player}` };
    if (run.mission_id !== this.missionId) return { ok: false, player, error: `run ${chainRunId} is for mission ${run.mission_id}, this server deals ${this.missionId}` };
    if (run.outcome) return { ok: false, player, error: `run ${chainRunId} is already settled` };
    return { ok: true, player };
  }

  async checkHire(chainRunId: string | null, npc: Npc, payment: unknown, used: Set<string>): Promise<HireCheck> {
    const idx = (payment as { hireIndex?: unknown } | null)?.hireIndex;
    if (!chainRunId || !Number.isInteger(idx)) return { ok: false, receipt: '', error: 'testnet: send "payment": {"hireIndex": <index returned by hire>}' };
    const receipt = `run ${chainRunId} hire #${idx}`;
    if (used.has(receipt)) return { ok: false, receipt, error: `hire #${idx} was already spent` };
    const run = await this.getRun(chainRunId, (r) => !!r && r.hires.length > (idx as number));
    const h = run?.hires[idx as number];
    if (!h) return { ok: false, receipt, error: `no hire #${idx} on run ${chainRunId}` };
    if (h.npc !== NPC_ENUM[npc]) return { ok: false, receipt, error: `hire #${idx} paid the ${h.npc}, not the ${NPC_ENUM[npc]}` };
    return { ok: true, receipt };
  }

  private async settlerAccount() {
    if (!this.settlerId || !this.settlerKey) throw new Error('SETTLER_ACCOUNT_ID and SETTLER_PRIVATE_KEY are not set');
    this.settler ??= (async () => {
      const { Account, JsonRpcProvider } = await import('near-api-js');
      return new Account(this.settlerId!, new JsonRpcProvider({ url: this.rpcUrl }), this.settlerKey as `ed25519:${string}`) as never;
    })();
    return this.settler;
  }

  async settle(chainRunId: string | null, cleared: boolean): Promise<SettleResult> {
    try {
      const acct = await this.settlerAccount();
      await acct.callFunction({ contractId: this.contractId, methodName: 'settle_run', args: { run_id: Number(chainRunId), cleared }, gas: 50_000_000_000_000n });
      return { ok: true, detail: cleared ? `settled on ${this.contractId}: reward paid` : `settled on ${this.contractId}: reward withheld` };
    } catch (e) {
      return { ok: false, detail: `settle failed: ${(e as Error).message}` };
    }
  }
}

export function chainFromEnv(env: NodeJS.ProcessEnv): Chain {
  if ((env.HEIST_CHAIN ?? 'mock') !== 'testnet') return new MockChain();
  const contract = env.HEIST_CONTRACT_ID;
  if (!contract) throw new Error('HEIST_CHAIN=testnet needs HEIST_CONTRACT_ID');
  return new TestnetChain(
    env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org',
    contract,
    env.HEIST_MISSION_ID ?? 'mission-1',
    env.SETTLER_ACCOUNT_ID ?? null,
    env.SETTLER_PRIVATE_KEY ?? null,
  );
}
