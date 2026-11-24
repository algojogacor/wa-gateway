import { describe, expect, it } from 'vitest';
import { LineBuffer, parseLine, encodeLine } from '../src/protocol.js';

describe('NDJSON protocol', () => {
  it('parses valid request lines', () => {
    expect(parseLine('{"t":"hello","consumer":"bot-prime"}')).toEqual({
      t: 'hello',
      consumer: 'bot-prime',
    });
    expect(parseLine('{"t":"ping"}')).toEqual({ t: 'ping' });
    expect(parseLine('{"t":"send","rid":"1","to":"x@g.us","text":"halo"}')?.t).toBe('send');
  });

  it('returns null for empty/garbage lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('not json')).toBeNull();
    expect(parseLine('{"t":42}')).toBeNull();
    expect(parseLine('[1,2]')).toBeNull();
  });

  it('line buffer handles partial writes across chunks', () => {
    const buf = new LineBuffer();
    const half = '{"t":"ping"}';
    expect(buf.push(half.slice(0, 5))).toEqual([]);
    const rest = buf.push(`${half.slice(5)}\n`);
    expect(rest).toEqual([half]);
    expect(buf.pending).toBe('');
  });

  it('line buffer splits multiple lines in one chunk', () => {
    const buf = new LineBuffer();
    const lines = buf.push('{"t":"ping"}\n{"t":"ping"}\n');
    expect(lines).toEqual(['{"t":"ping"}', '{"t":"ping"}']);
  });

  it('encodeLine terminates with newline and round-trips', () => {
    const line = encodeLine({ t: 'hello_ack', ok: true });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ t: 'hello_ack', ok: true });
  });
});
