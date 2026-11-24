import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { pino } from 'pino';
import { BaileysOwner } from './baileys.js';
import { ConsumerConnection, ConsumerRegistry } from './consumers.js';
import { routeByJid } from './router.js';
import { encodeLine, parseLine } from './protocol.js';
import type { GatewayEvent } from './protocol.js';

const log = pino({ level: process.env.WA_LOG_LEVEL ?? 'info', base: { mod: 'gateway' } });

const SOCKET_PATH = process.env.WA_SOCKET_PATH ?? 'run/wa-gateway.sock';
const AUTH_DIR = process.env.WA_AUTH_DIR ?? './auth_state';
const FLASHPEAK_GROUP_JID = process.env.WA_FLASHPEAK_GROUP_JID;
const ORGANIZER_JID = process.env.WA_ORGANIZER_JID;
const PAIRING_NUMBER = process.env.WA_PAIRING_NUMBER;

/** Extract conversational text from a Baileys proto message (best-effort). */
function extractText(m: {
  message?: { conversation?: string; extendedTextMessage?: { text?: string }; imageMessage?: { caption?: string }; videoMessage?: { caption?: string } };
}): string | undefined {
  const proto = m.message;
  if (!proto) return undefined;
  if (proto.conversation) return proto.conversation;
  if (proto.extendedTextMessage?.text) return proto.extendedTextMessage.text;
  if (proto.imageMessage?.caption) return proto.imageMessage.caption;
  if (proto.videoMessage?.caption) return proto.videoMessage.caption;
  return undefined;
}

async function main(): Promise<void> {
  const registry = new ConsumerRegistry((line) => log.warn(line));

  // pending send requests from consumers
  const pending = new Map<string, (ack: { ok: boolean; id?: string; err?: string }) => void>();

  const owner = new BaileysOwner(
    AUTH_DIR,
    (ev) => {
      if (ev.type === 'status') {
        registry.broadcast({ t: 'status', wa: ev.status ?? 'reconnecting' } as GatewayEvent);
        log.info({ wa: ev.status }, 'wa status');
        return;
      }
      for (const m of ev.messages ?? []) {
        const key = m.key;
        if (!key?.remoteJid) continue;
        if (key.remoteJid === 'status@broadcast') continue; // stories: no consumer wants them
        const event: GatewayEvent = {
          t: 'msg',
          id: key.id ?? '',
          ts: m.messageTimestamp ?? Date.now() / 1000 > 1e12 ? Number(m.messageTimestamp) : Date.now(),
          from: key.remoteJid,
          sender: key.participant ?? key.remoteJid,
          isGroup: key.remoteJid.endsWith('@g.us'),
          fromMe: key.fromMe ?? false,
          text: extractText(m as never),
          raw: { key, message: m.message },
        };
        const target = routeByJid(key.remoteJid, {
          flashpeakGroupJid: FLASHPEAK_GROUP_JID,
          organizerJid: ORGANIZER_JID,
        });
        const conn = registry.get(target);
        if (conn?.isOpen) {
          conn.send(event);
        } else {
          log.debug({ target, from: key.remoteJid }, 'no consumer attached; dropping message');
        }
      }
    },
    (line) => log.warn(line),
    (code) => log.info({ pairingCode: code }, 'pairing code issued'),
  );

  const server: Server = createServer((socket: Socket) => {
    let consumerId: string | null = null;

    const conn = new ConsumerConnection(
      socket,
      'pending',
      (id) => {
        if (id && id !== 'pending') registry.unregister(id);
        else if (consumerId) registry.unregister(consumerId);
      },
      async (_id, req) => {
        if (req.t === 'ping') {
          conn.send({ t: 'pong' });
          return;
        }
        if (req.t === 'hello') {
          const ok = registry.register(req.consumer, conn);
          // rewire the connection's id for future closes
          (conn as unknown as { id: string }).id = ok ? req.consumer : 'pending';
          consumerId = ok ? req.consumer : null;
          conn.send(ok ? { t: 'hello_ack', ok: true } : { t: 'hello_ack', ok: false, err: 'duplicate consumer id' });
          log.info({ consumer: req.consumer, ok }, 'consumer handshake');
          return;
        }
        if (req.t === 'send') {
          if (!owner.isConnected) {
            conn.send({ t: 'ack', rid: req.rid, ok: false, err: 'wa not connected' });
            return;
          }
          try {
            const { id } = await owner.sendText(req.to, req.text, {
              quoted: req.quoted,
              mentions: req.mentions,
            });
            conn.send({ t: 'ack', rid: req.rid, ok: true, id, ts: Date.now() });
          } catch (err) {
            conn.send({ t: 'ack', rid: req.rid, ok: false, err: String(err).slice(0, 120) });
          }
          return;
        }
        if (req.t === 'media') {
          // Media passthrough: download bytes of a media message via the
          // single Baileys owner, return base64 to the consumer. The gateway
          // stays transport-only — it never interprets the media.
          if (!owner.isConnected) {
            conn.send({ t: 'media_ack', rid: req.rid, ok: false, err: 'wa not connected' });
            return;
          }
          try {
            const { b64, mime } = await owner.downloadMedia(req.msg as never);
            conn.send({ t: 'media_ack', rid: req.rid, ok: true, b64, mime });
          } catch (err) {
            conn.send({ t: 'media_ack', rid: req.rid, ok: false, err: String(err).slice(0, 120) });
          }
          return;
        }
        void pending; // requests with rid-based promises live above; ping/hello/send are the full set
      },
      (line) => log.warn(line),
    );
    conn.start();
  });

  mkdirSync(dirname(SOCKET_PATH), { recursive: true }); // relative default resolves against cwd
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // socket file not present — fine
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, () => resolve());
  });
  log.info({ path: SOCKET_PATH }, 'gateway socket listening');

  const shutdown = async (): Promise<void> => {
    log.info('shutting down');
    await owner.stop().catch(() => {});
    server.close();
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Pairing-code registration keeps the owner-driven flow identical to the
  // old bots: number → code → user enters it once, session belongs to gateway.
  const sock = await owner.start();
  if (PAIRING_NUMBER && !sock.authState?.creds?.registered) {
    const code = (await sock.requestPairingCode(PAIRING_NUMBER)) ?? undefined;
    log.warn({ pairingCode: code }, 'PAIRING CODE — enter in WhatsApp > Perangkat Tertaut');
  }
}

void main().catch((err) => {
  log.error({ err }, 'gateway failed to start');
  process.exit(1);
});
