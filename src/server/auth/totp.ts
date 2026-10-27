import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 TOTP (HMAC-SHA1, 30-second steps, 6 digits): the parameters Google Authenticator,
 * Microsoft Authenticator, Authy, 1Password and other authenticator apps use by default.
 */
export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step to tolerate phone clock drift (±30 s). */
export const TOTP_WINDOW = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
}

export function totpCode(secretB32: string, step: number): string {
  return hotp(base32Decode(secretB32), step);
}

/** Normalises user input ("123 456" → "123456"); returns null when it cannot be a TOTP code. */
export function normalizeTotpInput(code: string): string | null {
  const c = code.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(c) ? c : null;
}

/**
 * Returns the matching time step, or null. Callers must reject steps at or before the last
 * accepted one so a code cannot be replayed within its validity window.
 */
export function matchTotp(secretB32: string, code: string, nowMs = Date.now(), window = TOTP_WINDOW): number | null {
  const normalized = normalizeTotpInput(code);
  if (!normalized) return null;
  const secret = base32Decode(secretB32);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Check every candidate (no early exit) so timing does not reveal which step matched.
  for (let step = current - window; step <= current + window; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(normalized)) && matched === null) matched = step;
  }
  return matched;
}

/** otpauth:// URI encoded in the enrollment QR code (Key Uri Format). */
export function otpauthUrl(secretB32: string, account: string, issuer = "TrustifyX Secure360"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SEC) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
