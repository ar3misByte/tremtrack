// Device simulator: produces the firmware's line protocol at 50 Hz and serves it like the ESP32 will.
//
//   npm run sim -- --ws                      WebSocket on ws://0.0.0.0:8787 (the app's "Wi-Fi or simulator")
//   npm run sim -- --stdout                  print lines (pipe into anything)
//   npm run sim -- --ws --tremor 2           fixed manual controls instead of the scripted showcase
//   npm run sim -- --ws --tremor 2,0 --phase 90      combined tremor: no-no + yes-yes, a quarter cycle apart (circular)
//   npm run sim -- --ws --hostsim tremor_no_4.5hz_6dps
//        stream the REAL firmware compiled by tools/hostsim (run `npm run hostsim` once to build it)
//
// Clients may send '1'..'5' (sensitivity); the simulator acknowledges with a '#' status line.
// MQTT publishing to AWS IoT Core is added in milestone 6.
import { WebSocketServer, type WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { DemoGenerator, scriptAt, DEFAULT_CONTROLS, type DemoControls } from '../../../app/src/logic/demoGen.ts';
import type { Axis } from '../../../app/src/logic/csv.ts';

export interface Options {
  ws: boolean; port: number; stdout: boolean; script: 'showcase' | 'manual';
  tremor: Axis[]; phase: number; walking: boolean; hostsim: string | null; quiet: boolean;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { ws: false, port: 8787, stdout: false, script: 'showcase', tremor: [], phase: 0, walking: false, hostsim: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--ws') o.ws = true;
    else if (a === '--port') o.port = Number(next());
    else if (a === '--stdout') o.stdout = true;
    else if (a === '--script') o.script = next() === 'manual' ? 'manual' : 'showcase';
    else if (a === '--tremor') { o.tremor = next().split(',').map(Number).filter((v): v is Axis => v === 0 || v === 1 || v === 2); o.script = 'manual'; }
    else if (a === '--phase') o.phase = Number(next()) || 0;
    else if (a === '--walking') { o.walking = true; o.script = 'manual'; }
    else if (a === '--hostsim') o.hostsim = next();
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') { console.log(fileURLToPath(import.meta.url) + '\nsee the header comment for usage'); process.exit(0); }
  }
  if (!o.ws && !o.stdout) o.ws = true;
  return o;
}

/** Starts producing lines; returns a stop function. */
export function startSource(o: Options, emit: (line: string) => void, log: (m: string) => void): () => void {
  if (o.hostsim) {
    const exe = process.platform === 'win32' ? '.exe' : '';
    const bin = fileURLToPath(new URL(`../../hostsim/bin/sim_current${exe}`, import.meta.url));
    if (!existsSync(bin)) throw new Error(`${bin} not found. Build it first: npm run hostsim`);
    let stopped = false;
    let child = run();
    function run() {
      const c = spawn(bin, ['--scenario', o.hostsim!, '--realtime']);
      let buf = '';
      c.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      c.stderr.on('data', (d: Buffer) => log(d.toString().trim()));
      c.on('close', () => { if (!stopped) { log(`hostsim scenario '${o.hostsim}' finished, restarting`); child = run(); } });
      return c;
    }
    log(`streaming real firmware output (hostsim scenario '${o.hostsim}')`);
    return () => { stopped = true; child.kill(); };
  }

  const gen = new DemoGenerator();
  const manual: DemoControls = { ...DEFAULT_CONTROLS, tremorAxes: o.tremor, comboPhaseDeg: o.phase, walking: o.walking };
  const t0 = performance.now();
  let lastLabel = '';
  emit('# Tremor Stream simulator (devsim) starting');
  emit('# Streaming');
  const timer = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    let c = manual;
    if (o.script === 'showcase') {
      const s = scriptAt(t);
      c = s.controls;
      if (s.label !== lastLabel) { lastLabel = s.label; log(`t=${t.toFixed(0)}s  ${s.label}`); }
    }
    emit(gen.next(t, c));
  }, 20);
  return () => clearInterval(timer);
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n!.address);
}

export function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const log = (m: string) => { if (!o.quiet) process.stderr.write(`[devsim] ${m}\n`); };
  const clients = new Set<WebSocket>();
  let wss: WebSocketServer | null = null;

  if (o.ws) {
    wss = new WebSocketServer({ port: o.port });
    wss.on('connection', (ws, req) => {
      clients.add(ws);
      log(`client connected from ${req.socket.remoteAddress} (${clients.size} total)`);
      ws.on('message', (m) => {
        const s = m.toString().trim();
        if (/^[1-5]$/.test(s)) { log(`sensitivity ${s} requested`); ws.send(`# Sensitivity ${s}\n`); }
      });
      ws.on('close', () => { clients.delete(ws); log(`client left (${clients.size} total)`); });
    });
    log(`WebSocket on ws://localhost:${o.port}` + lanAddresses().map((a) => `  ws://${a}:${o.port}`).join(''));
  }

  // batch lines per 20 ms tick into one WebSocket message to keep overhead low
  let pending: string[] = [];
  const stop = startSource(o, (line) => {
    if (o.stdout) process.stdout.write(line + '\n');
    pending.push(line);
  }, log);
  const flush = setInterval(() => {
    if (!pending.length) return;
    const msg = pending.join('\n') + '\n';
    pending = [];
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  }, 20);

  const shutdown = () => { stop(); clearInterval(flush); wss?.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { shutdown, wss };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
