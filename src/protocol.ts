/**
 * NDJSON wire protocol shared by wa-gateway and its consumers.
 * One JSON object per newline-terminated line, UTF-8.
 *
 * Messages are intentionally minimal: routing needs "who sent this, from
 * where, what text". Everything richer (media envelopes, full Baileys proto)
 * rides in `raw` so consumers keep their own normalizers — the gateway stays
 * a dumb forwarder.
 */

export type GatewayEvent =
  | { t: 'hello_ack'; ok: true }
  | { t: 'hello_ack'; ok: false; err: string }
  | { t: 'status'; wa: 'connected' | 'connecting' | 'reconnecting' | 'logged_out' }
  | {
      t: 'msg';
      id: string;
      ts: number;
      /** chat JID: group (@g.us) or peer (@s.whatsapp.net) */
      from: string;
      /** author of the message inside a group */
      sender: string;
      isGroup: boolean;
      fromMe: boolean;
      text?: string;
      quoted?: { id: string; text?: string };
      /** minimal Baileys envelope for consumers needing media/proto detail */
      raw?: unknown;
    };

export type ConsumerRequest =
  | { t: 'hello'; consumer: string }
  | { t: 'send'; rid: string; to: string; text: string; typingMs?: number; quoted?: unknown; mentions?: string[] }
  | { t: 'media'; rid: string; msg: unknown }
  | { t: 'ping' };

export type GatewayAck =
  | { t: 'ack'; rid: string; ok: true; id?: string; ts?: number }
  | { t: 'ack'; rid: string; ok: false; err: string }
  | { t: 'media_ack'; rid: string; ok: true; b64: string; mime: string }
  | { t: 'media_ack'; rid: string; ok: false; err: string }
  | { t: 'pong' };

/** Parse one NDJSON line safely. Returns null on empty/invalid lines. */
export function parseLine(line: string): ConsumerRequest | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as ConsumerRequest;
    if (obj && typeof obj === 'object' && typeof obj.t === 'string') return obj;
    return null;
  } catch {
    return null;
  }
}

/** Serialize an outbound line (gateway → consumer). */
export function encodeLine(obj: GatewayEvent | GatewayAck): string {
  return `${JSON.stringify(obj)}\n`;
}

/**
 * Incremental line-buffer parser for the socket data stream.
 * Robust against partial TCP/socket writes: keeps the remainder until the
 * next newline arrives.
 */
export class LineBuffer {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      lines.push(this.buf.slice(0, idx));
      this.buf = this.buf.slice(idx + 1);
    }
    return lines;
  }

  /** Unparsed tail (for tests only). */
  get pending(): string {
    return this.buf;
  }
}
