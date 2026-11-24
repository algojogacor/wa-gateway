import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type ConnectionState,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';

export type BaileysEvent = {
  type: 'message' | 'status';
  /** For 'message': the raw WAMessage. */
  messages?: WAMessage[];
  /** For 'status'. */
  status?: 'connected' | 'connecting' | 'reconnecting' | 'logged_out';
};

/**
 * The ONLY Baileys owner on the box. File-based auth in its own directory —
 * deliberately not the DB auth of bot-prime: zero dependencies beyond the
 * socket itself, and the session belongs to the gateway, not to any consumer.
 *
 * Reconnect policy: Baileys' built-in retry (connection.update cycle) with a
 * hard stop on logged_out (auth wiped by WhatsApp) — the pairing code path
 * then re-registers from scratch.
 */
export class BaileysOwner {
  private sock: WASocket | null = null;
  private stopping = false;
  private pairingAfterStart: { number: string; onCode: (code: string) => void } | null = null;

  constructor(
    private readonly authDir: string,
    private readonly emit: (ev: BaileysEvent) => void,
    private readonly log: (line: string) => void,
    private readonly onPairingCode?: (code: string) => void,
  ) {}

  get isConnected(): boolean {
    return this.sock !== null && this.stopping === false;
  }

  /**
   * A pairing attempt that issued a code but never got registered leaves
   * creds with pairingCode consumed + registered false; WhatsApp answers
   * 401 forever on those. Detect and wipe so a plain `pm2 restart
   * wa-gateway` always yields a FRESH pairing code (the owner's refresh
   * path when a code expires before it can be entered).
   */
  private wipeStaleHalfPair(): void {
    try {
      const credsPath = join(this.authDir, 'creds.json');
      if (!existsSync(credsPath)) return;
      const creds = JSON.parse(readFileSync(credsPath, 'utf8')) as {
        registered?: boolean;
        pairingCode?: unknown;
        me?: unknown;
      };
      const halfPaired = creds.registered !== true && 'pairingCode' in creds && creds.me;
      if (halfPaired) {
        this.log('stale half-paired creds detected; wiping auth_state for a fresh pairing');
        for (const f of readdirSync(this.authDir)) {
          if (f === 'creds.json' || f.startsWith('pre-key') || f === 'session') {
            rmSync(join(this.authDir, f), { force: true });
          }
        }
      }
    } catch (err) {
      this.log(`half-pair check failed (continuing): ${String(err).slice(0, 80)}`);
    }
  }

  /** Deferred pairing-code request: fires once the first QR arrives. */
  requestPairingAfterQr(number: string, onCode: (code: string) => void): void {
    this.pairingAfterStart = { number, onCode };
  }

  async start(): Promise<WASocket> {
    if (!existsSync(this.authDir)) mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
    this.wipeStaleHalfPair();
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ['WA Gateway', 'Chrome', '1.0.0'],
      // Baileys calls logger.error/trace/... on its internal paths; every
      // method must exist or a transient network error crashes the process.
      logger: makeSilentBaileysLogger() as never,
      syncFullHistory: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;
      const pairingCode = (update as unknown as { pairingCode?: string }).pairingCode;
      if (qr) {
        this.log('QR ready — scan from WhatsApp > Perangkat Tertaut');
        qrcodeTerminal.generate(qr, { small: true });
        void writeFileSync('./PAIRING_QR.txt', `${new Date().toISOString()}
${qr}
`);
        // Baileys 7: pairing-code requests are only valid once the QR/ws
        // link is live; asking earlier throws 'Connection Closed'.
        if (this.pairingAfterStart) {
          const { number, onCode } = this.pairingAfterStart;
          this.pairingAfterStart = null;
          void sock
            .requestPairingCode(number)
            .then((code) => {
              if (code) {
                onCode(code);
                void writeFileSync('./PAIRING_CODE.txt', `${new Date().toISOString()}
${code}
`);
              }
            })
            .catch((err) => this.log(`pairing code request failed: ${String(err).slice(0, 100)}`));
        }
      }
      if (pairingCode && this.onPairingCode) this.onPairingCode(pairingCode);
      if (connection === 'open') {
        this.sock = sock;
        this.emit({ type: 'status', status: 'connected' });
      }
      if (connection === 'connecting') this.emit({ type: 'status', status: 'connecting' });
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { data?: { code?: number } } | undefined)?.data?.code;
        const reason = code ?? (lastDisconnect?.error as { code?: number } | undefined)?.code;
        const isLogout = reason === DisconnectReason.loggedOut;
        this.emit({ type: 'status', status: isLogout ? 'logged_out' : 'reconnecting' });
        if (isLogout) {
          this.log('WhatsApp logged the session out; auth cleared — needs re-pairing');
          this.sock = null;
          // Baileys exits its loop here; a fresh start() re-registers (QR/pairing).
          return;
        }
        // transient close → Baileys standard reconnect path re-runs internally
        // via the same socket config; restart the socket ourselves.
        if (!this.stopping) {
          setTimeout(() => {
            void this.reconnect();
          }, 2_000 + Math.floor(Math.random() * 1_000));
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages }: { messages: WAMessage[] }) => {
      this.emit({ type: 'message', messages });
    });

    return sock;
  }

  private async reconnect(): Promise<void> {
    try {
      await this.start();
    } catch (err) {
      this.log(`reconnect failed: ${String(err).slice(0, 120)}; retrying`);
      setTimeout(() => void this.reconnect(), 5_000);
    }
  }

  async sendText(
    to: string,
    text: string,
    opts?: { quoted?: unknown; mentions?: string[] },
  ): Promise<{ id?: string }> {
    if (!this.sock) throw new Error('wa not connected');
    const content: Record<string, unknown> = { text };
    if (opts?.mentions?.length) content.mentions = opts.mentions;
    const sendOpts: Record<string, unknown> = {};
    if (opts?.quoted) sendOpts.quoted = opts.quoted;
    const sent = await this.sock.sendMessage(to, content as never, sendOpts as never);
    return { id: sent?.key?.id ?? undefined };
  }

  /** Media download passthrough for consumers (score screenshots etc.). */
  async downloadMedia(msg: unknown): Promise<{ b64: string; mime: string }> {
    if (!this.sock) throw new Error('wa not connected');
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    const buffer = (await downloadMediaMessage(
      msg as never,
      'buffer',
      {},
      {
        logger: { level: 'silent' } as never,
        reuploadRequest: (m: unknown) => this.sock!.updateMediaMessage(m as never),
      } as never,
    )) as Buffer;
    if (!buffer?.length) throw new Error('empty media');
    if (buffer.length > 10 * 1024 * 1024) throw new Error('media exceeds 10MB cap');
    const proto = (msg as { message?: { imageMessage?: { mimetype?: string }; videoMessage?: { mimetype?: string }; documentMessage?: { mimetype?: string } } })
      .message;
    const mime =
      proto?.imageMessage?.mimetype ??
      proto?.videoMessage?.mimetype ??
      proto?.documentMessage?.mimetype ??
      'application/octet-stream';
    return { b64: buffer.toString('base64'), mime };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sock) await this.sock.end(undefined).catch(() => {});
    this.sock = null;
  }
}

/** Full no-op logger: Baileys expects all pino methods to be present. */
function makeSilentBaileysLogger(): Record<string, (...args: unknown[]) => void> {
  const noop = (): void => undefined;
  const log: Record<string, (...args: unknown[]) => void> = {};
  for (const m of ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'level', 'child']) {
    if (m === 'child') log[m] = () => makeSilentBaileysLogger() as never;
    else if (m === 'level') log[m] = 'silent' as never;
    else log[m] = noop;
  }
  return log;
}
