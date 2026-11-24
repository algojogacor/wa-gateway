/**
 * The only "logic" in the gateway by design: which consumer owns a chat.
 * Two rules, nothing else — no command parsing, no keyword sniffing.
 */

export type ConsumerId = 'bot-prime' | 'flashpeak';

export type RouteConfig = {
  /** Tournament group JID served by Flash Peak TMS. */
  flashpeakGroupJid: string | undefined;
  /** Optional organizer DM JID also served by Flash Peak. */
  organizerJid: string | undefined;
};

export function routeByJid(from: string, cfg: RouteConfig): ConsumerId {
  // strip the device suffix: '628x:14@s.whatsapp.net' → '628x@s.whatsapp.net'
  const clean = from.replace(/:\d+@/, '@');
  if (cfg.flashpeakGroupJid && clean === cfg.flashpeakGroupJid) return 'flashpeak';
  if (cfg.organizerJid && clean === cfg.organizerJid) return 'flashpeak';
  return 'bot-prime';
}
