/**
 * Authentication route handlers.
 *
 * Public endpoints (no auth required):
 *   POST /auth/login           — Email + password → sends OTP, returns otp_token
 *   POST /auth/verify-otp      — OTP code + otp_token → returns JWT
 *   POST /auth/forgot-password  — Sends password reset OTP
 *   POST /auth/reset-password   — OTP + new password → resets password
 *
 * Protected endpoints (JWT required):
 *   POST /auth/logout           — Invalidate current session
 *   GET  /auth/me               — Get current user profile
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import { jsonResponse, errorResponse } from '../utils/response';
import {
  generateSalt,
  hashPassword,
  verifyPassword,
  generateOTP,
  hashOTP,
  hashTokenId,
} from '../utils/crypto';
import { createJWT, verifyJWT } from '../utils/jwt';
import { sendOTPEmail } from '../utils/email';

/* ================================================================
 * POST /auth/login
 * ================================================================ */

export async function handleLogin(
  request: Request,
  sql: postgres.Sql,
  env: Env,
): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { email, password } = body;
  if (!email || !password) {
    return errorResponse(400, 'Email and password are required');
  }

  // 1. Look up user (case-insensitive)
  const users = await sql`
    SELECT id, email, password_hash, salt, display_name, role,
           tenant_id, customer_name, is_active, failed_logins, locked_until
    FROM auth_users
    WHERE email_lower = ${email.toLowerCase()}
  `;

  if (users.length === 0) {
    // Timing-safe: do a dummy hash to prevent user-enumeration via timing
    await hashPassword('dummy-password', generateSalt());
    return errorResponse(401, 'Invalid email or password');
  }

  const user = users[0];

  // 2. Check account lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil(
      (new Date(user.locked_until).getTime() - Date.now()) / 60_000,
    );
    return errorResponse(
      423,
      'Account temporarily locked',
      `Too many failed attempts. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`,
    );
  }

  // 3. Check active
  if (!user.is_active) {
    return errorResponse(403, 'Account disabled', 'Contact your administrator.');
  }

  // 4. Verify password
  const valid = await verifyPassword(password, user.password_hash, user.salt);
  if (!valid) {
    const newCount = (user.failed_logins || 0) + 1;
    const lockUntil =
      newCount >= 5
        ? new Date(Date.now() + 15 * 60 * 1000).toISOString()
        : null;
    await sql`
      UPDATE auth_users
      SET failed_logins = ${newCount},
          locked_until = ${lockUntil},
          updated_at = now()
      WHERE id = ${user.id}
    `;
    return errorResponse(401, 'Invalid email or password');
  }

  // 5. Reset failed counter on successful password check
  if (user.failed_logins > 0) {
    await sql`
      UPDATE auth_users
      SET failed_logins = 0, locked_until = NULL, updated_at = now()
      WHERE id = ${user.id}
    `;
  }

  // 6. Generate OTP
  const otpCode = generateOTP();
  const otpHash = await hashOTP(otpCode);
  const otpMinutes = parseInt(env.OTP_TTL_MINUTES || '5');
  const otpExpiry = new Date(Date.now() + otpMinutes * 60_000);

  await sql`
    INSERT INTO auth_otp (user_id, code_hash, purpose, expires_at)
    VALUES (${user.id}, ${otpHash}, 'login_2fa', ${otpExpiry.toISOString()})
  `;

  // 7. Send OTP email via Resend
  try {
    await sendOTPEmail({
      to: user.email,
      name: user.display_name,
      code: otpCode,
      purpose: 'login',
      apiKey: env.BREVO_API_KEY,
      fromEmail: env.OTP_FROM_EMAIL || 'noreply@simsy.co.uk',
    });
  } catch (err) {
    console.error('[AUTH] Failed to send OTP email:', err);
    return errorResponse(
      503,
      'Failed to send verification email',
      'Please try again in a moment.',
    );
  }

  // 8. Create OTP pending token in KV (10-minute TTL)
  const otpToken = crypto.randomUUID();
  await env.TENANT_KV.put(
    `otp_pending:${otpToken}`,
    JSON.stringify({ user_id: user.id, email: user.email }),
    { expirationTtl: 600 },
  );

  // 9. Mask email for display
  const [localPart, domain] = user.email.split('@');
  const masked =
    localPart.length <= 2
      ? `${localPart[0]}***@${domain}`
      : `${localPart[0]}${'*'.repeat(localPart.length - 2)}${localPart[localPart.length - 1]}@${domain}`;

  return jsonResponse({
    status: 'otp_required',
    otp_token: otpToken,
    email_hint: masked,
    expires_in: otpMinutes * 60,
  });
}

/* ================================================================
 * POST /auth/verify-otp
 * ================================================================ */

export async function handleVerifyOTP(
  request: Request,
  sql: postgres.Sql,
  env: Env,
): Promise<Response> {
  let body: { otp_token?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { otp_token, code } = body;
  if (!otp_token || !code) {
    return errorResponse(400, 'otp_token and code are required');
  }

  // 1. Look up OTP pending session from KV
  const pending = (await env.TENANT_KV.get(`otp_pending:${otp_token}`, 'json')) as {
    user_id: string;
    email: string;
  } | null;
  if (!pending) {
    return errorResponse(401, 'Invalid or expired verification session');
  }

  // 2. Find latest unused OTP for this user
  const otps = await sql`
    SELECT id, code_hash, attempts, max_attempts, expires_at
    FROM auth_otp
    WHERE user_id = ${pending.user_id}
      AND purpose = 'login_2fa'
      AND used_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (otps.length === 0) {
    return errorResponse(401, 'Verification code expired. Please log in again.');
  }

  const otp = otps[0];

  // 3. Check attempt limit
  if (otp.attempts >= otp.max_attempts) {
    await env.TENANT_KV.delete(`otp_pending:${otp_token}`);
    return errorResponse(429, 'Too many attempts. Please log in again.');
  }

  // 4. Verify code
  const codeHash = await hashOTP(code);
  if (codeHash !== otp.code_hash) {
    await sql`UPDATE auth_otp SET attempts = attempts + 1 WHERE id = ${otp.id}`;
    const remaining = otp.max_attempts - otp.attempts - 1;
    return errorResponse(
      401,
      'Invalid verification code',
      `${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
    );
  }

  // 5. Mark OTP as used
  await sql`UPDATE auth_otp SET used_at = now() WHERE id = ${otp.id}`;
  await env.TENANT_KV.delete(`otp_pending:${otp_token}`);

  // 6. Fetch full user + tenant info
  const users = await sql`
    SELECT u.id, u.email, u.display_name, u.role, u.tenant_id, u.customer_name,
           t.tenant_name
    FROM auth_users u
    JOIN rpt_tenants t ON t.tenant_id = u.tenant_id
    WHERE u.id = ${pending.user_id}
  `;

  if (users.length === 0) {
    return errorResponse(500, 'User record not found');
  }

  const user = users[0];

  // 7. Create JWT
  const ttlHours = parseInt(env.SESSION_TTL_HOURS || '24');
  const { token, jti, expiresAt } = await createJWT(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenant_id: user.tenant_id,
      tenant_name: user.tenant_name,
      customer_name: user.customer_name || undefined,
    },
    env.JWT_SECRET,
    ttlHours,
  );

  // 8. Store session in DB + KV
  const tokenHash = await hashTokenId(jti);

  await sql`
    INSERT INTO auth_sessions (user_id, token_hash, expires_at, ip_address, user_agent)
    VALUES (
      ${user.id},
      ${tokenHash},
      ${expiresAt.toISOString()},
      ${request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown'},
      ${(request.headers.get('User-Agent') || 'unknown').slice(0, 500)}
    )
  `;

  await env.TENANT_KV.put(`session:${tokenHash}`, '1', {
    expirationTtl: ttlHours * 3600,
  });

  // 9. Update last login
  await sql`UPDATE auth_users SET last_login_at = now() WHERE id = ${user.id}`;

  return jsonResponse({
    token,
    expires_at: expiresAt.toISOString(),
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      tenant_id: user.tenant_id,
      tenant_name: user.tenant_name,
      customer_name: user.customer_name || null,
    },
  });
}

/* ================================================================
 * POST /auth/logout
 * ================================================================ */

export async function handleLogout(
  request: Request,
  sql: postgres.Sql,
  env: Env,
  tenant: TenantInfo,
): Promise<Response> {
  if (tenant.auth_method !== 'jwt') {
    return errorResponse(400, 'Not a JWT session');
  }

  // Extract jti from the current JWT
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.slice(7);
  if (!token) return errorResponse(400, 'Missing token');

  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (payload) {
    const tokenHash = await hashTokenId(payload.jti);
    // Remove from KV (instant invalidation)
    await env.TENANT_KV.delete(`session:${tokenHash}`);
    // Remove from DB
    await sql`DELETE FROM auth_sessions WHERE token_hash = ${tokenHash}`;
  }

  return jsonResponse({ status: 'logged_out' });
}

/* ================================================================
 * GET /auth/me
 * ================================================================ */

export async function handleMe(
  sql: postgres.Sql,
  tenant: TenantInfo,
): Promise<Response> {
  if (!tenant.user_id) {
    return errorResponse(400, 'User info only available for JWT sessions');
  }

  const users = await sql`
    SELECT u.id, u.email, u.display_name, u.role, u.tenant_id, u.customer_name,
           u.last_login_at, u.created_at, t.tenant_name
    FROM auth_users u
    JOIN rpt_tenants t ON t.tenant_id = u.tenant_id
    WHERE u.id = ${tenant.user_id}
  `;

  if (users.length === 0) {
    return errorResponse(404, 'User not found');
  }

  const user = users[0];
  return jsonResponse({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    tenant_id: user.tenant_id,
    tenant_name: user.tenant_name,
    customer_name: user.customer_name || null,
    last_login_at: user.last_login_at,
    created_at: user.created_at,
  });
}

/* ================================================================
 * POST /auth/forgot-password
 * ================================================================ */

export async function handleForgotPassword(
  request: Request,
  sql: postgres.Sql,
  env: Env,
): Promise<Response> {
  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { email } = body;
  if (!email) {
    return errorResponse(400, 'Email is required');
  }

  // Always return success to prevent email enumeration
  const successMsg = {
    status: 'ok',
    message: 'If an account exists with that email, a reset code has been sent.',
  };

  const users = await sql`
    SELECT id, email, display_name, is_active
    FROM auth_users
    WHERE email_lower = ${email.toLowerCase()}
  `;

  if (users.length === 0 || !users[0].is_active) {
    // Do a dummy delay to match timing of the real path
    await hashPassword('dummy', generateSalt());
    return jsonResponse(successMsg);
  }

  const user = users[0];

  // Generate OTP
  const otpCode = generateOTP();
  const otpHash = await hashOTP(otpCode);
  const otpMinutes = parseInt(env.OTP_TTL_MINUTES || '5');
  const otpExpiry = new Date(Date.now() + otpMinutes * 60_000);

  await sql`
    INSERT INTO auth_otp (user_id, code_hash, purpose, expires_at)
    VALUES (${user.id}, ${otpHash}, 'password_reset', ${otpExpiry.toISOString()})
  `;

  // Store pending reset in KV
  const resetToken = crypto.randomUUID();
  await env.TENANT_KV.put(
    `reset_pending:${resetToken}`,
    JSON.stringify({ user_id: user.id, email: user.email }),
    { expirationTtl: 600 },
  );

  // Send email
  try {
    await sendOTPEmail({
      to: user.email,
      name: user.display_name,
      code: otpCode,
      purpose: 'password_reset',
      apiKey: env.BREVO_API_KEY,
      fromEmail: env.OTP_FROM_EMAIL || 'noreply@simsy.co.uk',
    });
  } catch (err) {
    console.error('[AUTH] Failed to send reset email:', err);
    // Still return success to prevent enumeration
  }

  return jsonResponse({ ...successMsg, reset_token: resetToken });
}

/* ================================================================
 * POST /auth/reset-password
 * ================================================================ */

export async function handleResetPassword(
  request: Request,
  sql: postgres.Sql,
  env: Env,
): Promise<Response> {
  let body: { reset_token?: string; code?: string; new_password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { reset_token, code, new_password } = body;
  if (!reset_token || !code || !new_password) {
    return errorResponse(400, 'reset_token, code, and new_password are required');
  }

  if (new_password.length < 12) {
    return errorResponse(400, 'Password must be at least 12 characters');
  }

  // 1. Look up reset session from KV
  const pending = (await env.TENANT_KV.get(`reset_pending:${reset_token}`, 'json')) as {
    user_id: string;
    email: string;
  } | null;
  if (!pending) {
    return errorResponse(401, 'Invalid or expired reset session');
  }

  // 2. Find latest unused OTP
  const otps = await sql`
    SELECT id, code_hash, attempts, max_attempts, expires_at
    FROM auth_otp
    WHERE user_id = ${pending.user_id}
      AND purpose = 'password_reset'
      AND used_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (otps.length === 0) {
    return errorResponse(401, 'Reset code expired. Please request a new one.');
  }

  const otp = otps[0];

  // 3. Check attempts
  if (otp.attempts >= otp.max_attempts) {
    await env.TENANT_KV.delete(`reset_pending:${reset_token}`);
    return errorResponse(429, 'Too many attempts. Please request a new code.');
  }

  // 4. Verify code
  const codeHash = await hashOTP(code);
  if (codeHash !== otp.code_hash) {
    await sql`UPDATE auth_otp SET attempts = attempts + 1 WHERE id = ${otp.id}`;
    return errorResponse(401, 'Invalid reset code');
  }

  // 5. Mark OTP used
  await sql`UPDATE auth_otp SET used_at = now() WHERE id = ${otp.id}`;
  await env.TENANT_KV.delete(`reset_pending:${reset_token}`);

  // 6. Update password
  const salt = generateSalt();
  const passwordHash = await hashPassword(new_password, salt);

  await sql`
    UPDATE auth_users
    SET password_hash = ${passwordHash},
        salt = ${salt},
        password_changed_at = now(),
        failed_logins = 0,
        locked_until = NULL,
        updated_at = now()
    WHERE id = ${pending.user_id}
  `;

  // 7. Invalidate all existing sessions for this user
  const sessions = await sql`
    SELECT token_hash FROM auth_sessions WHERE user_id = ${pending.user_id}
  `;
  for (const session of sessions) {
    await env.TENANT_KV.delete(`session:${session.token_hash}`);
  }
  await sql`DELETE FROM auth_sessions WHERE user_id = ${pending.user_id}`;

  return jsonResponse({
    status: 'ok',
    message: 'Password has been reset. Please log in with your new password.',
  });
}
