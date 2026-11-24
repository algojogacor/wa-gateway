#!/usr/bin/env node
/**
 * Pre-deploy end-to-end test of the wa-gateway stack WITHOUT WhatsApp.
 * Uses the REAL compiled internals (dist/consumers.js, dist/router.js,
 * dist/protocol.js) over a REAL Unix socket server — the only thing not
 * exercised is the Baileys socket itself (external service).
 */
import { createServer, connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { ConsumerConnection, ConsumerRegistry } = await import('./dist/consumers.js');
const { routeByJid } = await import('./dist/router.js');
const { encodeLine, parseLine } = await import('./dist/protocol.js');

const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
const sockPath = join(dir, 'gw.sock');
const log = [];
const registry = new ConsumerRegistry((l) => log.push(l));
const sends = [];

const server = createServer((socket) => {
  const conn = new ConsumerConnection(
    socket,
    'pending',
    (id) => { if (id !== 'pending') registry.unregister(id); },
    async (_id, req) => {
      if (req.t === 'hello') {
        const ok = registry.register(req.consumer, conn);
        conn.id = ok ? req.consumer : 'pending';
        conn.send(ok ? { t: 'hello_ack', ok: true } : { t: 'hello_ack', ok: false, err: 'duplicate' });
        return;
      }
      if (req.t === 'send') {
        sends.push({ to: req.to, text: req.text });
        conn.send({ t: 'ack', rid: req.rid, ok: true, id: `SIM-${sends.length}`, ts: Date.now() });
        return;
      }
      if (req.t === 'ping') conn.send({ t: 'pong' });
    },
    (l) => log.push(l),
  );
  conn.start();
});
await new Promise((r) => server.listen(sockPath, r));

function dial() {
  return new Promise((resolve, reject) => {
    const sock = connect(sockPath);
    const state = { lines: [], raw: '' };
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      state.raw += d;
      let i;
      while ((i = state.raw.indexOf('\n')) !== -1) {
        const line = state.raw.slice(0, i);
        state.raw = state.raw.slice(i + 1);
        if (line.trim()) state.lines.push(line);
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => resolve({ sock, state }));
  });
}

const bp = await dial();
bp.sock.write(encodeLine({ t: 'hello', consumer: 'bot-prime' }));
const fp = await dial();
fp.sock.write(encodeLine({ t: 'hello', consumer: 'flashpeak' }));

async function got(c, pred, ms = 2000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const objs = c.state.lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
    const hit = objs.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

const bpAck = await got(bp, (o) => o?.t === 'hello_ack');
const fpAck = await got(fp, (o) => o?.t === 'hello_ack');
const tests = [
  ['handshake bot-prime', bpAck?.ok === true],
  ['handshake flashpeak', fpAck?.ok === true],
];

// Inbound WA message simulation via the REAL routing path.
function waInbound(from, participant, text) {
  const ev = {
    t: 'msg', id: `E${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(),
    from, sender: participant, isGroup: from.endsWith('@g.us'), fromMe: false,
    text, raw: { key: { remoteJid: from, id: 'x', participant }, message: { conversation: text } },
  };
  const target = routeByJid(from, {
    flashpeakGroupJid: '120363412423738009@g.us',
    organizerJid: '6281234567890@s.whatsapp.net',
  });
  const conn = registry.get(target);
  if (conn?.isOpen) conn.send(ev);
  return target;
}

// T1: tournament group → flashpeak only
const t1 = waInbound('120363412423738009@g.us', '6281@s.whatsapp.net', '!quiz start');
tests.push(['T1 route tournament → flashpeak', t1 === 'flashpeak']);
const fpMsg = await got(fp, (o) => o?.t === 'msg' && o.text === '!quiz start');
tests.push(['T1 flashpeak received', !!fpMsg]);
const bpLeak = await got(bp, (o) => o?.t === 'msg' && o.text === '!quiz start', 300);
tests.push(['T1 bot-prime NOT receiving it', bpLeak === null]);

// T2: !omak command in another group → bot-prime
const t2 = waInbound('120363000999@g.us', '6282@s.whatsapp.net', '!omak opinion dong');
tests.push(['T2 route !omak → bot-prime', t2 === 'bot-prime']);
const bpMsg = await got(bp, (o) => o?.t === 'msg' && o.text?.includes('!omak'));
tests.push(['T2 bot-prime received', !!bpMsg]);

// T3: personal DM → bot-prime
const t3 = waInbound('628999000111@s.whatsapp.net', '628999000111@s.whatsapp.net', 'halo');
tests.push(['T3 route DM → bot-prime', t3 === 'bot-prime']);

// T4: flashpeak reply through gateway
fp.sock.write(encodeLine({ t: 'send', rid: 'FP1', to: '120363412423738009@g.us', text: 'quiz dimulai round 1' }));
const fpSendAck = await got(fp, (o) => o?.t === 'ack' && o.rid === 'FP1');
tests.push(['T4 flashpeak send acked', fpSendAck?.ok === true]);
tests.push(['T4 gateway sent to tournament group', sends.at(-1)?.to === '120363412423738009@g.us' && sends.at(-1)?.text === 'quiz dimulai round 1']);

// T5: bot-prime multi-bubble replies in order
bp.sock.write(encodeLine({ t: 'send', rid: 'BP1', to: '120363000999@g.us', text: 'paragraf satu' }));
bp.sock.write(encodeLine({ t: 'send', rid: 'BP2', to: '120363000999@g.us', text: 'paragraf dua' }));
const a1 = await got(bp, (o) => o?.t === 'ack' && o.rid === 'BP1');
const a2 = await got(bp, (o) => o?.t === 'ack' && o.rid === 'BP2');
tests.push(['T5 both bubbles acked', !!a1 && !!a2]);
tests.push(['T5 ordering preserved', sends.slice(-2).map((s) => s.text).join('|') === 'paragraf satu|paragraf dua']);

// T6: status broadcast to both
registry.broadcast({ t: 'status', wa: 'reconnecting' });
const st1 = await got(bp, (o) => o?.t === 'status' && o.wa === 'reconnecting');
const st2 = await got(fp, (o) => o?.t === 'status' && o.wa === 'reconnecting');
tests.push(['T6 status broadcast both', !!st1 && !!st2]);

// T7: duplicate consumer rejected
const dup = await dial();
dup.sock.write(encodeLine({ t: 'hello', consumer: 'bot-prime' }));
const dupAck = await got(dup, (o) => o?.t === 'hello_ack');
tests.push(['T7 duplicate hello rejected', dupAck?.ok === false]);

// T8: consumer restart — old socket closes, new hello accepted
bp.sock.destroy();
await new Promise((r) => setTimeout(r, 100));
const bp2 = await dial();
bp2.sock.write(encodeLine({ t: 'hello', consumer: 'bot-prime' }));
const bp2Ack = await got(bp2, (o) => o?.t === 'hello_ack');
tests.push(['T8 reconnect after drop', bp2Ack?.ok === true]);

let fail = 0;
for (const [name, ok] of tests) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) fail++;
}
console.log(fail === 0 ? '\nE2E: ALL PASS' : `\nE2E: ${fail} FAILURES`);
server.close();
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
