// One-command demo: starts a local server (mock chain), then plays three scripted leads.
//   npm run demo            fast clock, exits when done
//   npm run demo -- --serve  keeps the server up so you can open the spectator page
import { Runs } from '../src/runs.ts';
import { MockChain } from '../src/chain.ts';
import { makeServer } from '../src/server.ts';
import { playScripted } from './scripted.ts';

const serve = process.argv.includes('--serve');
const port = Number(process.env.PORT ?? 8787);
const chain = new MockChain();
const runs = new Runs({ missionSecret: 'local-demo-secret', chain, timeScale: Number(process.env.HEIST_TIME_SCALE ?? 0.02), dataDir: process.env.HEIST_DATA_DIR ?? 'data/runs' });
const server = makeServer(runs, chain);
await new Promise<void>((r) => server.listen(port, r));
const base = `http://localhost:${port}`;
console.log(`Ante Heist demo on ${base} (mock chain, fast clock)\n`);

const mock = async () => ({ mock: true });
const results: { style: string; runId: string; status: string }[] = [];
for (const style of ['solo', 'hire', 'reckless'] as const) {
  const { runId, transcript } = await playScripted({ base, style, pay: mock, start: { player: `${style}-lead.testnet` }, log: console.log });
  results.push({ style, runId, status: (transcript as { status: string }).status });
  console.log('');
}

console.log('Summary');
for (const r of results) console.log(`  ${r.style.padEnd(9)} ${r.status.padEnd(8)} ${base}/#${r.runId}`);

if (serve) console.log(`\nSpectator page: ${base}  (Ctrl+C to stop)`);
else server.close();
