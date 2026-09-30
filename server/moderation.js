// Message checks for a public chat on a coin site: no links, no contract addresses
// (the classic fake-CA scam), profanity censored, owner-editable blocklist, rate limits.
import fs from 'node:fs';
import { RegExpMatcher, TextCensor, englishDataset, englishRecommendedTransformers, asteriskCensorStrategy } from 'obscenity';

export const MAX_LEN = 40;

const matcher = new RegExpMatcher({ ...englishDataset.build(), ...englishRecommendedTransformers });
const censor = new TextCensor().setStrategy(asteriskCensorStrategy());

const LINK = /(https?:|www\.|t\.me\/|discord\.(gg|com)|\bbit\.ly\b|[a-z0-9-]{2,}\s*(\.|\[\.\]|\(dot\)|\sdot\s)\s*(com|io|xyz|net|org|app|gg|me|co|fun|sol|lol|finance|site|online|link|to|ly|ai|vip|pro|club|cash|money|exchange|claims?|gift|tech|dev|info|biz|live|top|win|eth|pump)\b)/i;
const EVM_ADDR = /0x[0-9a-f]{16,}/i;
// Solana / Bitcoin style: 30+ base58 characters mixing digits, upper and lower case
const B58_ADDR = /\b(?=[1-9A-HJ-NP-Za-km-z]*\d)(?=[1-9A-HJ-NP-Za-km-z]*[A-HJ-NP-Z])(?=[1-9A-HJ-NP-Za-km-z]*[a-km-z])[1-9A-HJ-NP-Za-km-z]{30,}\b/;
const LONG_HEX = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{24,}\b/i;   // hashes, keys, addresses without 0x

export function loadBlocklist(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim().toLowerCase()).filter((s) => s && !s.startsWith('#'));
  } catch { return []; }
}

/**
 * Clean a message. Returns {ok:true, text} or {ok:false, code, message}.
 * @param {string} raw
 * @param {string[]} blocklist lower-case phrases that reject a message outright
 */
export function checkMessage(raw, blocklist = []) {
  if (typeof raw !== 'string') return { ok: false, code: 'bad', message: 'Messages must be text.' };
  let text = raw.normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return { ok: false, code: 'empty', message: 'Type something first.' };
  if ([...text].length > MAX_LEN) text = [...text].slice(0, MAX_LEN).join('');
  const scam = findScam(text);
  if (scam) return { ok: false, ...scam };
  const lower = text.toLowerCase();
  if (blocklist.some((w) => lower.includes(w))) return { ok: false, code: 'blocked', message: 'That message is not allowed.' };
  const matches = matcher.getAllMatches(text);
  if (matches.length) text = censor.applyTo(text, matches);
  return { ok: true, text };
}

/** Links and wallet/contract addresses, the two things a fake-CA scam needs. Null when clean. */
export function findScam(text) {
  if (LINK.test(text)) return { code: 'link', message: 'Links are not allowed.' };
  if (EVM_ADDR.test(text) || B58_ADDR.test(text) || LONG_HEX.test(text)) {
    return { code: 'address', message: 'Wallet and contract addresses are not allowed in chat.' };
  }
  return null;
}

/** Token bucket per key. */
export class RateLimiter {
  constructor({ ratePerSec, burst }) { this.rate = ratePerSec; this.burst = burst; this.buckets = new Map(); }
  take(key, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, t: now }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.t) / 1000) * this.rate);
    b.t = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  /** Give back a token taken for something that turned out not to count (a request refused before any work). */
  refund(key) { const b = this.buckets.get(key); if (b) b.tokens = Math.min(this.burst, b.tokens + 1); }
  /** Seconds until `key` has a token again. */
  wait(key, now = Date.now()) {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const tokens = Math.min(this.burst, b.tokens + ((now - b.t) / 1000) * this.rate);
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / this.rate);
  }
  sweep(now = Date.now()) {
    for (const [k, b] of this.buckets) if (now - b.t > 10 * 60 * 1000) this.buckets.delete(k);
  }
}
