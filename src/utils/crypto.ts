/**
 * Cryptographic utilities for authentication.
 *
 * Uses the Web Crypto API (available in Cloudflare Workers).
 * Password hashing uses PBKDF2-SHA256 with 100,000 iterations
 * (Cloudflare Workers Web Crypto API limit).
 */

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32; // 256 bits

/* ---------- Helpers ---------- */

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/* ---------- Password hashing ---------- */

/** Generate a random 16-byte salt, returned as base64. */
export function generateSalt(): string {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return toBase64(salt.buffer);
}

/** Hash a password with PBKDF2-SHA256. Returns a base64 string. */
export async function hashPassword(password: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const saltBytes = fromBase64(salt);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    HASH_BYTES * 8,
  );

  return toBase64(bits);
}

/** Verify a password against a stored hash+salt. Constant-time comparison. */
export async function verifyPassword(
  password: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  const computed = await hashPassword(password, salt);

  // Constant-time comparison to prevent timing attacks
  if (computed.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}

/* ---------- OTP ---------- */

/** Generate a random 6-digit OTP code. */
export function generateOTP(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, '0');
}

/** SHA-256 hash an OTP code (or any short string). Returns base64. */
export async function hashOTP(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return toBase64(digest);
}

/* ---------- Token hashing ---------- */

/** SHA-256 hash a JWT jti for session storage. Returns base64. */
export async function hashTokenId(jti: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jti));
  return toBase64(digest);
}
