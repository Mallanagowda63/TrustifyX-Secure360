import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters (m=19 MiB, t=2, p=1).
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const COMMON = new Set([
  "password1234",
  "123456789012",
  "qwertyuiopas",
  "passwordpassword",
  "letmein12345",
  "administrator",
  "welcome12345",
  "trustifyx123",
]);

export function passwordProblems(password: string, email?: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters";
  if (password.length > 128) return "Password must be at most 128 characters";
  if (COMMON.has(password.toLowerCase())) return "This password is too common";
  if (/^(.)\1+$/.test(password)) return "Password must not be a single repeated character";
  if (email && password.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) {
    return "Password must not contain your email name";
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    return false;
  }
}

// Used to keep login timing uniform when the account does not exist.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing-only");
  await verifyPassword(await dummyHash, password);
}
