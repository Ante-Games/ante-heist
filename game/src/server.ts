import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runs, GameError } from './runs.ts';
import { chainFromEnv, type Chain } from './chain.ts';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function makeServer(runs: Runs, chain: Chain) {
  return createServer(async (req, res) => {
    try {
      await route(req, res, runs, chain);
    } catch (e) {
      const status = e instanceof GameError ? e.status : 500;
      if (status === 500) console.error(e);
      json(res, status, { error: (e as Error).message });
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse, runs: Runs, chain: Chain) {
  const url = new URL(req.url ?? '/', 'http://local');
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method ?? 'GET';

  if (m === 'GET' && parts.length === 0) return file(res, 'index.html', 'text/html; charset=utf-8');
  if (m === 'GET' && url.pathname === '/skill.md') {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
    const base = process.env.PUBLIC_URL ?? `${proto}://${req.headers.host ?? 'localhost'}`;
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    return res.end(readFileSync(join(PUBLIC, 'skill.md'), 'utf8').replaceAll('{{BASE}}', base));
  }
  if (m === 'GET' && url.pathname === '/rules') return json(res, 200, { ...runs.rules(), chain: chain.describe(), commitment: runs.commitment });
  if (m === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

  if (parts[0] === 'runs') {
    if (parts.length === 1 && m === 'GET') return json(res, 200, runs.list());
    if (parts.length === 1 && m === 'POST') return json(res, 201, await runs.create(await body(req)));
    const id = parts[1];
    if (parts.length === 2 && m === 'GET') return json(res, 200, runs.view(id));
    if (parts.length === 3 && m === 'POST') {
      const b = await body(req);
      switch (parts[2]) {
        case 'probe': return json(res, 200, await runs.probe(id, b.room));
        case 'bench': return json(res, 200, await runs.bench(id, b.lock, b.guess));
        case 'hire': return json(res, 200, await runs.hire(id, b));
        case 'plan': return json(res, 200, await runs.submit(id, b));
      }
    }
  }
  throw new GameError(404, `no route ${m} ${url.pathname}; see /skill.md`);
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

function file(res: ServerResponse, name: string, type: string) {
  res.writeHead(200, { 'content-type': type });
  res.end(readFileSync(join(PUBLIC, name)));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new GameError(413, 'body too large');
  }
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through */ }
  throw new GameError(400, 'body must be a JSON object');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chain = chainFromEnv(process.env);
  let secret = process.env.HEIST_MISSION_SECRET;
  if (!secret) {
    if (chain.mode === 'testnet') throw new Error('HEIST_MISSION_SECRET is required on testnet');
    secret = 'local-demo-secret';
    console.warn('HEIST_MISSION_SECRET not set: using the public local demo secret.');
  }
  const runs = new Runs({
    missionSecret: secret,
    chain,
    timeScale: Number(process.env.HEIST_TIME_SCALE ?? 1),
    dataDir: process.env.HEIST_DATA_DIR ?? 'data/runs',
  });
  const port = Number(process.env.PORT ?? 8787);
  makeServer(runs, chain).listen(port, () => console.log(`Ante Heist on http://localhost:${port} (chain: ${chain.mode})`));
}
