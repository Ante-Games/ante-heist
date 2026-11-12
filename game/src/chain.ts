import { NPC_PRICE_YOCTO, REWARD_YOCTO, formatNear, type Npc } from './rules.ts';

export interface StartCheck { ok: boolean; player: string | null; error?: string }
// `tx`/`explorer` prove the payment on chain; `paidTo` is the NPC account that received it.
export interface HireCheck { ok: boolean; receipt: string; error?: string; paid?: string; paidTo?: string; tx?: string; explorer?: string }
export interface SettleResult { ok: boolean; detail: string; tx?: string; explorer?: string }

// What the game server needs from the chain. The server never moves funds itself except
// through `settle`, which only the settlement key can call on the contract.
export interface Chain {
  mode: 'mock' | 'testnet';
  describe(): Record<string, unknown>;
  checkStart(chainRunId: string | null, player: string | null): Promise<StartCheck>;
  checkHire(chainRunId: string | null, npc: Npc, payment: unknown, used: Set<string>): Promise<HireCheck>;
  settle(chainRunId: string | null, cleared: boolean): Promise<SettleResult>;
}


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
    return { ok: true, receipt: `mock-hire-${++this.n}-${npc}`, paid: `${formatNear(NPC_PRICE_YOCTO[npc])} NEAR (mock, not paid)` };
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
  private settler: Promise<{ callFunctionRaw: (a: Record<string, unknown>) => Promise<{ transaction: { hash: string } }> }> | null = null;
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
        `to hire: call ${this.contractId}.hire({"run_id":<run_id>,"npc":"scout|cryptographer|operator|analyst"}) with the price attached, then POST the hire with {"payment":{"hireIndex":<index it returned>}}`,
      ],
      explorer: `https://testnet.nearblocks.io/address/${this.contractId}`,
      reward: `${formatNear(REWARD_YOCTO)} NEAR`,
      prices: Object.fromEntries(Object.entries(NPC_PRICE_YOCTO).map(([k, v]) => [k, `${formatNear(v)} NEAR`])),
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
    if (h.npc.toLowerCase() !== npc) return { ok: false, receipt, error: `hire #${idx} paid the ${h.npc.toLowerCase()}, not the ${npc}` };
    const paid = `${formatNear(BigInt(h.paid))} NEAR`;
    const paidTo = await this.npcAccount(npc).catch(() => undefined);
    // Optional proof: the hash of the player's `hire` transaction. It is checked, then echoed with an explorer link.
    const tx = (payment as { tx?: unknown }).tx;
    if (tx === undefined) {
      return { ok: true, receipt, paid, paidTo, ...(paidTo ? { explorer: `https://testnet.nearblocks.io/address/${paidTo}` } : {}) };
    }
    if (typeof tx !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(tx)) return { ok: false, receipt, error: '"payment.tx" must be the hire transaction hash' };
    const why = await this.checkHireTx(tx, run!.player, chainRunId, idx as number);
    if (why) return { ok: false, receipt, error: `payment.tx ${tx}: ${why}` };
    return { ok: true, receipt, paid, paidTo, tx, explorer: `https://testnet.nearblocks.io/txns/${tx}` };
  }

  private npcAccounts = new Map<Npc, string>();
  private async npcAccount(npc: Npc): Promise<string> {
    if (!this.npcAccounts.has(npc)) this.npcAccounts.set(npc, (await this.view<{ account: string }>('get_npc', { npc })).account);
    return this.npcAccounts.get(npc)!;
  }

  // The transaction must be the player's own `hire` call on this contract, for this run, and it
  // must have returned this hire index. Returns null when it checks out, or the reason it doesn't.
  private async checkHireTx(hash: string, player: string, chainRunId: string, idx: number): Promise<string | null> {
    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'heist', method: 'tx', params: { tx_hash: hash, sender_account_id: player, wait_until: 'EXECUTED_OPTIMISTIC' } }),
    });
    const body = (await res.json()) as {
      error?: { cause?: { name?: string }; message?: string };
      result?: { status?: { SuccessValue?: string }; transaction?: { signer_id: string; receiver_id: string; actions: unknown[] } };
    };
    if (body.error) return body.error.cause?.name === 'UNKNOWN_TRANSACTION' ? `not found as a transaction sent by ${player}` : `rpc: ${body.error.message ?? 'error'}`;
    const t = body.result?.transaction;
    if (!t || t.receiver_id !== this.contractId) return `not a call to ${this.contractId}`;
    const call = t.actions
      .map((a) => (a as { FunctionCall?: { method_name: string; args: string } }).FunctionCall)
      .find((f) => f?.method_name === 'hire');
    if (!call) return 'not a hire call';
    let args: { run_id?: unknown };
    try { args = JSON.parse(Buffer.from(call.args, 'base64').toString('utf8')); } catch { return 'unreadable hire arguments'; }
    if (String(args.run_id) !== chainRunId) return `hired for run ${String(args.run_id)}, not run ${chainRunId}`;
    const ret = body.result?.status?.SuccessValue;
    if (ret === undefined) return 'the hire call did not succeed';
    if (Buffer.from(ret, 'base64').toString('utf8') !== String(idx)) return `returned hire #${Buffer.from(ret, 'base64').toString('utf8')}, not #${idx}`;
    return null;
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
      const out = await acct.callFunctionRaw({ contractId: this.contractId, methodName: 'settle_run', args: { run_id: Number(chainRunId), cleared }, gas: 50_000_000_000_000n });
      const tx = out.transaction.hash;
      const detail = cleared ? `settled on ${this.contractId}: ${formatNear(REWARD_YOCTO)} NEAR reward paid` : `settled on ${this.contractId}: reward withheld`;
      return { ok: true, detail, tx, explorer: `https://testnet.nearblocks.io/txns/${tx}` };
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
    env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com',
    contract,
    env.HEIST_MISSION_ID ?? 'mission-1',
    env.SETTLER_ACCOUNT_ID ?? null,
    env.SETTLER_PRIVATE_KEY ?? null,
  );
}
