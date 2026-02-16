/**
 * JWT creation and verification using the Web Crypto API.
 *
 * Uses HS256 (HMAC-SHA256) signing. No external dependencies.
 * Designed for Cloudflare Workers where native crypto is available.
 */

export interface JWTPayload {
  /** User ID */
  sub: string;
  email: string;
  role: 'admin' | 'tenant' | 'customer';
  tenant_id: string;
  tenant_name: string;
  customer_name?: string;
  /** Unique token ID — used for session revocation */
  jti: string;
  /** Issued at (Unix seconds) */
  iat: number;
  /** Expiry (Unix seconds) */
  exp: number;
}

/* ---------- Base64-URL helpers ---------- */

function base64UrlEncode(input: string | ArrayBuffer): string {
  const str =
    typeof input === 'string'
      ? btoa(input)
      : btoa(String.fromCharCode(...new Uint8Array(input)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  let padded = str.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  return atob(padded);
}

function base64UrlDecodeBytes(str: string): Uint8Array {
  const raw = base64UrlDecode(str);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/* ---------- HMAC key ---------- */

async function getSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/* ---------- Public API ---------- */

export interface CreateJWTResult {
  /** The signed JWT string */
  token: string;
  /** The unique token ID (unhashed — for KV storage after hashing) */
  jti: string;
  /** When the token expires */
  expiresAt: Date;
}

/**
 * Create a signed JWT with the given payload claims.
 *
 * @param claims  - Payload fields (sub, email, role, tenant_id, tenant_name, customer_name?)
 * @param secret  - The HS256 signing secret
 * @param ttlHours - Token lifetime in hours
 */
export async function createJWT(
  claims: Omit<JWTPayload, 'jti' | 'iat' | 'exp'>,
  secret: string,
  ttlHours: number,
): Promise<CreateJWTResult> {
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlHours * 3600;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JWTPayload = { ...claims, jti, iat: now, exp };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await getSigningKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const encodedSignature = base64UrlEncode(signature);

  return {
    token: `${signingInput}.${encodedSignature}`,
    jti,
    expiresAt: new Date(exp * 1000),
  };
}

/**
 * Verify and decode a JWT.
 *
 * Returns the payload if valid and not expired, or null otherwise.
 */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    // Verify signature
    const key = await getSigningKey(secret);
    const signatureBytes = base64UrlDecodeBytes(encodedSignature);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBytes,
      new TextEncoder().encode(signingInput),
    );
    if (!valid) return null;

    // Decode payload
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as JWTPayload;

    // Check expiration
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
