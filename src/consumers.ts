import type { Socket } from 'node:net';
import { LineBuffer, parseLine, encodeLine } from './protocol.js';
import type { GatewayEvent, GatewayAck, ConsumerRequest } from './protocol.js';

/**
 * One connected consumer. Owns a single write queue so event order is strict
 * FIFO per consumer (Unix-socket writes are ordered anyway; the queue keeps
 * slow consumers from blocking the Baileys event loop).
 *
 * Reliability policy (RAM first):
 *  - queue high-water = 256 lines (~512 KB worst case): beyond that we close
 *    the consumer socket; it reconnects and rejoins — better than letting a
 *    stuck consumer balloon the gateway heap.
 *  - if the consumer is simply gone, socket write fails → drop with a
 *    rate-limited log line. No cross-process queueing: chat is near-real-time,
 *    delivering stale bursts later would be worse than dropping.
 */
export class ConsumerConnection {
  readonly id: string;
  private queue: string[] = [];
  private writing = false;
  private closed = false;
  /** Rate-limited drop logging: first line logs, rest within 60 s do not. */
  private lastDropLog = 0;

  constructor(
    private readonly socket: Socket,
    id: string,
    private readonly onClose: (id: string) => void,
    private readonly onRequest: (id: string, req: ConsumerRequest) => Promise<void> | void,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.id = id;
  }

  start(): void {
    const lines = new LineBuffer();
    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const req = parseLine(line);
        if (!req) continue;
        void this.onRequest(this.id, req);
      }
    });
    this.socket.on('error', () => this.close('socket error'));
    this.socket.on('close', () => this.close('socket closed'));
  }

  send(event: GatewayEvent | GatewayAck): void {
    if (this.closed) return;
    this.queue.push(encodeLine(event));
    if (this.queue.length > 256) {
      this.log(`consumer ${this.id} queue high-water; closing for clean reconnect`);
      this.socket.destroy();
      return;
    }
    void this.flush();
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this.id);
    this.socket.destroy();
    if (reason !== 'socket closed') this.log(`consumer ${this.id} closed: ${reason}`);
  }

  get isOpen(): boolean {
    return !this.closed && !this.socket.destroyed;
  }

  private async flush(): Promise<void> {
    if (this.writing || this.closed) return;
    this.writing = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const line = this.queue[0] as string;
        await new Promise<void>((resolve, reject) => {
          this.socket.write(line, (err) => (err ? reject(err) : resolve()));
        });
        this.queue.shift();
      }
    } catch {
      this.close('write failed');
    } finally {
      this.writing = false;
    }
  }
}

/**
 * Registry of live consumers. Rejects a duplicate `hello` for an id that is
 * still connected — the old process must be dead before a new one joins
 * (prevents two bot-prime instances quietly splitting events).
 */
export class ConsumerRegistry {
  private readonly consumers = new Map<string, ConsumerConnection>();
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  register(id: string, conn: ConsumerConnection): boolean {
    const existing = this.consumers.get(id);
    if (existing?.isOpen) {
      this.log(`duplicate hello for consumer ${id}; rejecting`);
      return false;
    }
    this.consumers.set(id, conn);
    return true;
  }

  unregister(id: string): void {
    this.consumers.delete(id);
  }

  get(id: string): ConsumerConnection | undefined {
    return this.consumers.get(id);
  }

  list(): string[] {
    return [...this.consumers.keys()].filter((id) => this.consumers.get(id)?.isOpen);
  }

  /** Broadcast a status event (WA connection state) to everyone attached. */
  broadcast(event: GatewayEvent): void {
    for (const conn of this.consumers.values()) {
      if (conn.isOpen) conn.send(event);
    }
  }
}
