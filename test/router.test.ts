import { describe, expect, it } from 'vitest';
import { routeByJid } from '../src/router.js';

const cfg = {
  flashpeakGroupJid: '120363412423738009@g.us',
  organizerJid: '6281234567890@s.whatsapp.net',
};

describe('gateway routing (the only rules that exist)', () => {
  it('routes the tournament group to flashpeak', () => {
    expect(routeByJid('120363412423738009@g.us', cfg)).toBe('flashpeak');
  });

  it('routes the organizer DM to flashpeak', () => {
    expect(routeByJid('6281234567890@s.whatsapp.net', cfg)).toBe('flashpeak');
  });

  it('routes every other chat to bot-prime (commands, other groups, DMs)', () => {
    expect(routeByJid('628999000111@s.whatsapp.net', cfg)).toBe('bot-prime');
    expect(routeByJid('120363000000999@g.us', cfg)).toBe('bot-prime');
  });

  it('strips device suffix before matching', () => {
    expect(routeByJid('6281234567890:14@s.whatsapp.net', cfg)).toBe('flashpeak');
  });

  it('falls back to bot-prime when no flashpeak jids configured', () => {
    expect(routeByJid('120363412423738009@g.us', { flashpeakGroupJid: undefined, organizerJid: undefined })).toBe(
      'bot-prime',
    );
  });
});
