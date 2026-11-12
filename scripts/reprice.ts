// Owner-only: set each NPC's on-chain price to the server's NPC_PRICE_YOCTO (keeps the NPC accounts).
// Usage: node --env-file=.env.testnet --env-file=.env.owner scripts/reprice.ts
import { Account, JsonRpcProvider } from 'near-api-js';
import { NPCS, NPC_PRICE_YOCTO, formatNear } from '../game/src/rules.ts';

const rpc = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const contractId = process.env.HEIST_CONTRACT_ID!;
const provider = new JsonRpcProvider({ url: rpc });
const owner = new Account(process.env.OWNER_ACCOUNT_ID!, provider, process.env.OWNER_PRIVATE_KEY as `ed25519:${string}`);
for (const npc of NPCS) {
  const info = await provider.callFunction({ contractId, method: 'get_npc', args: { npc } }) as { account: string; price: string };
  if (BigInt(info.price) === NPC_PRICE_YOCTO[npc]) { console.log(`${npc}: already ${formatNear(NPC_PRICE_YOCTO[npc])} NEAR`); continue; }
  await owner.callFunction({ contractId, methodName: 'set_npc', args: { npc, account: info.account, price: NPC_PRICE_YOCTO[npc].toString() }, gas: 30_000_000_000_000n });
  console.log(`${npc}: ${formatNear(BigInt(info.price))} → ${formatNear(NPC_PRICE_YOCTO[npc])} NEAR (${info.account})`);
}
