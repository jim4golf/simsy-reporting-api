/**
 * Admin route handlers.
 *
 * All routes require admin role + JWT authentication.
 * The admin-guard middleware checks this before routing here.
 *
 * Routes:
 *   GET    /admin/users                  — List users (paginated, searchable)
 *   POST   /admin/users                  — Create user
 *   GET    /admin/users/:id              — Get user detail
 *   PUT    /admin/users/:id              — Update user
 *   DELETE /admin/users/:id              — Soft-delete (deactivate)
 *   POST   /admin/users/:id/reset-password — Set new password
 *   GET    /admin/sessions               — List active sessions
 *   DELETE /admin/sessions/:id           — Revoke session
 *   GET    /admin/tenants                — List tenants
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import { jsonResponse, paginatedResponse, errorResponse } from '../utils/response';
import { generateSalt, hashPassword } from '../utils/crypto';
import { parsePagination, paginationOffset } from '../utils/pagination';
import { sendInviteEmail } from '../utils/email';
import type { RateLimitResult } from '../middleware/rate-limit';

/* ================================================================
 * GET /admin/users
 * ================================================================ */

export async function handleListUsers(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult,
): Promise<Response> {
  const { page, pageSize } = parsePagination(searchParams, env);
  const offset = paginationOffset({ page, pageSize });
  const search = searchParams.get('search') || '';
  const roleFilter = searchParams.get('role') || '';
  const activeFilter = searchParams.get('active'); // 'true', 'false', or null

  // Build conditions
  const conditions: string[] = [];
  const params: (string | number | boolean)[] = [];
  let paramIndex = 0;

  if (search) {
    paramIndex++;
    const searchLower = `%${search.toLowerCase()}%`;
    conditions.push(
      `(u.email_lower LIKE $${paramIndex} OR LOWER(u.display_name) LIKE $${paramIndex})`,
    );
    params.push(searchLower);
  }

  if (roleFilter && ['admin', 'tenant', 'customer'].includes(roleFilter)) {
    paramIndex++;
    conditions.push(`u.role = $${paramIndex}`);
    params.push(roleFilter);
  }

  if (activeFilter === 'true' || activeFilter === 'false') {
    paramIndex++;
    conditions.push(`u.is_active = $${paramIndex}`);
    params.push(activeFilter === 'true');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total
  const countResult = await sql.unsafe(
    `SELECT COUNT(*) AS total FROM auth_users u ${whereClause}`,
    params as any[],
  );
  const total = parseInt(countResult[0].total);

  // Fetch page
  const rows = await sql.unsafe(
    `SELECT u.id, u.email, u.display_name, u.role, u.tenant_id, u.customer_name,
            u.is_active, u.last_login_at, u.created_at, u.updated_at,
            t.tenant_name
     FROM auth_users u
     JOIN rpt_tenants t ON t.tenant_id = u.tenant_id
     ${whereClause}
     ORDER BY u.created_at DESC
     LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`,
    [...params, pageSize, offset] as any[],
  );

  const users = rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    email: r.email,
    display_name: r.display_name,
    role: r.role,
    tenant_id: r.tenant_id,
    tenant_name: r.tenant_name,
    customer_name: r.customer_name || null,
    is_active: r.is_active,
    last_login_at: r.last_login_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  return paginatedResponse(users, total, page, pageSize, rateLimit);
}

/* ================================================================
 * POST /admin/users
 * ================================================================ */

export async function handleCreateUser(
  request: Request,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { email, display_name, role, tenant_id, customer_name } = body as {
    email?: string;
    display_name?: string;
    role?: string;
    tenant_id?: string;
    customer_name?: string;
  };

  // Validate required fields (no password — user sets it via invite link)
  if (!email || !display_name || !role || !tenant_id) {
    return errorResponse(400, 'Missing required fields: email, display_name, role, tenant_id');
  }

  if (!['admin', 'tenant', 'customer'].includes(role)) {
    return errorResponse(400, 'Invalid role. Must be admin, tenant, or customer.');
  }

  if (role === 'customer' && !customer_name) {
    return errorResponse(400, 'customer_name is required for customer role');
  }

  // Validate email format
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return errorResponse(400, 'Invalid email format');
  }

  // Check tenant exists
  const tenants = await sql`SELECT tenant_id FROM rpt_tenants WHERE tenant_id = ${tenant_id}`;
  if (tenants.length === 0) {
    return errorResponse(400, 'Invalid tenant_id');
  }

  // Check duplicate email
  const existing = await sql`
    SELECT id FROM auth_users WHERE email_lower = ${email.toLowerCase()}
  `;
  if (existing.length > 0) {
    return errorResponse(409, 'An account with this email already exists');
  }

  // Create user without password (pending invite)
  const result = await sql`
    INSERT INTO auth_users (email, password_hash, salt, display_name, role, tenant_id, customer_name, is_active, created_by)
    VALUES (${email}, ${null}, ${null}, ${display_name}, ${role}, ${tenant_id},
            ${role === 'customer' ? customer_name! : null},
            false,
            ${tenant.user_id || null})
    RETURNING id, email, display_name, role, tenant_id, customer_name, is_active, created_at
  `;

  const created = result[0];

  // Generate invite token (48-hour expiry) and store in KV
  const inviteToken = crypto.randomUUID();
  await env.TENANT_KV.put(
    `invite:${inviteToken}`,
    JSON.stringify({ user_id: created.id, email: created.email }),
    { expirationTtl: 48 * 60 * 60 }, // 48 hours
  );

  // Also store an OTP record for audit trail
  await sql`
    INSERT INTO auth_otp (user_id, code_hash, purpose, expires_at)
    VALUES (${created.id}, ${inviteToken}, 'invite',
            ${new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()})
  `;

  // Send invite email
  const frontendUrl = env.FRONTEND_URL || 'https://simsy-reporting.pages.dev';
  const inviteUrl = `${frontendUrl}/index.html#set-password?token=${inviteToken}`;

  let emailSent = false;
  try {
    await sendInviteEmail({
      to: created.email,
      name: created.display_name,
      inviteUrl,
      apiKey: env.BREVO_API_KEY,
      fromEmail: env.OTP_FROM_EMAIL || 'noreply@s-imsy.com',
    });
    emailSent = true;
  } catch (err) {
    console.error('[ADMIN] Failed to send invite email:', err);
  }

  return jsonResponse(
    {
      id: created.id,
      email: created.email,
      display_name: created.display_name,
      role: created.role,
      tenant_id: created.tenant_id,
      customer_name: created.customer_name || null,
      is_active: created.is_active,
      created_at: created.created_at,
      invite_sent: emailSent,
    },
    201,
  );
}

/* ================================================================
 * GET /admin/users/:id
 * ================================================================ */

export async function handleGetUser(
  userId: string,
  sql: postgres.Sql,
): Promise<Response> {
  const users = await sql`
    SELECT u.id, u.email, u.display_name, u.role, u.tenant_id, u.customer_name,
           u.is_active, u.failed_logins, u.locked_until, u.last_login_at,
           u.password_changed_at, u.created_at, u.updated_at,
           t.tenant_name
    FROM auth_users u
    JOIN rpt_tenants t ON t.tenant_id = u.tenant_id
    WHERE u.id = ${userId}
  `;

  if (users.length === 0) {
    return errorResponse(404, 'User not found');
  }

  const u = users[0];
  return jsonResponse({
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    tenant_id: u.tenant_id,
    tenant_name: u.tenant_name,
    customer_name: u.customer_name || null,
    is_active: u.is_active,
    failed_logins: u.failed_logins,
    locked_until: u.locked_until,
    last_login_at: u.last_login_at,
    password_changed_at: u.password_changed_at,
    created_at: u.created_at,
    updated_at: u.updated_at,
  });
}

/* ================================================================
 * PUT /admin/users/:id
 * ================================================================ */

export async function handleUpdateUser(
  userId: string,
  request: Request,
  sql: postgres.Sql,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  // Check user exists
  const existing = await sql`SELECT id FROM auth_users WHERE id = ${userId}`;
  if (existing.length === 0) {
    return errorResponse(404, 'User not found');
  }

  // Build update fields
  const updates: string[] = [];
  const params: (string | number | boolean | null)[] = [];
  let paramIndex = 0;

  const allowedFields: Record<string, string> = {
    display_name: 'display_name',
    role: 'role',
    tenant_id: 'tenant_id',
    customer_name: 'customer_name',
    is_active: 'is_active',
  };

  for (const [key, column] of Object.entries(allowedFields)) {
    if (body[key] !== undefined) {
      paramIndex++;
      updates.push(`${column} = $${paramIndex}`);
      params.push(body[key] as string | number | boolean | null);
    }
  }

  if (updates.length === 0) {
    return errorResponse(400, 'No valid fields to update');
  }

  // Validate role if being changed
  if (body.role && !['admin', 'tenant', 'customer'].includes(body.role as string)) {
    return errorResponse(400, 'Invalid role');
  }

  // Validate tenant if being changed
  if (body.tenant_id) {
    const tenants = await sql`SELECT tenant_id FROM rpt_tenants WHERE tenant_id = ${body.tenant_id as string}`;
    if (tenants.length === 0) {
      return errorResponse(400, 'Invalid tenant_id');
    }
  }

  // Add updated_at
  updates.push(`updated_at = now()`);

  paramIndex++;
  params.push(userId);

  await sql.unsafe(
    `UPDATE auth_users SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
    params as any[],
  );

  // Return the updated user
  return handleGetUser(userId, sql);
}

/* ================================================================
 * DELETE /admin/users/:id — permanently delete user
 * ================================================================ */

export async function handleDeleteUser(
  userId: string,
  sql: postgres.Sql,
  env: Env,
  tenant: TenantInfo,
): Promise<Response> {
  // Prevent self-deletion
  if (tenant.user_id === userId) {
    return errorResponse(400, 'Cannot delete your own account');
  }

  const existing = await sql`SELECT id, email FROM auth_users WHERE id = ${userId}`;
  if (existing.length === 0) {
    return errorResponse(404, 'User not found');
  }

  // Revoke all active sessions for this user
  const sessions = await sql`
    SELECT token_hash FROM auth_sessions WHERE user_id = ${userId}
  `;
  for (const session of sessions) {
    await env.TENANT_KV.delete(`session:${session.token_hash}`);
  }
  await sql`DELETE FROM auth_sessions WHERE user_id = ${userId}`;

  // Delete OTP records
  await sql`DELETE FROM auth_otp WHERE user_id = ${userId}`;

  // Delete the user record permanently
  await sql`DELETE FROM auth_users WHERE id = ${userId}`;

  return jsonResponse({ status: 'ok', message: 'User permanently deleted' });
}

/* ================================================================
 * POST /admin/users/:id/resend-invite — send (or re-send) invite
 * ================================================================ */

export async function handleResendInvite(
  userId: string,
  sql: postgres.Sql,
  env: Env,
): Promise<Response> {
  const users = await sql`
    SELECT id, email, display_name, password_hash
    FROM auth_users WHERE id = ${userId}
  `;

  if (users.length === 0) {
    return errorResponse(404, 'User not found');
  }

  const user = users[0];

  // If user already has a password set, they don't need an invite
  if (user.password_hash) {
    return errorResponse(400, 'User has already set their password. Use password reset instead.');
  }

  // Invalidate any previous invite tokens for this user
  const oldInvites = await sql`
    SELECT code_hash FROM auth_otp WHERE user_id = ${userId} AND purpose = 'invite' AND used_at IS NULL
  `;
  for (const inv of oldInvites) {
    await env.TENANT_KV.delete(`invite:${inv.code_hash}`);
  }
  await sql`
    UPDATE auth_otp SET used_at = now()
    WHERE user_id = ${userId} AND purpose = 'invite' AND used_at IS NULL
  `;

  // Generate new invite token (48-hour expiry)
  const inviteToken = crypto.randomUUID();
  await env.TENANT_KV.put(
    `invite:${inviteToken}`,
    JSON.stringify({ user_id: user.id, email: user.email }),
    { expirationTtl: 48 * 60 * 60 },
  );

  // Audit record
  await sql`
    INSERT INTO auth_otp (user_id, code_hash, purpose, expires_at)
    VALUES (${user.id}, ${inviteToken}, 'invite',
            ${new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()})
  `;

  // Send invite email
  const frontendUrl = env.FRONTEND_URL || 'https://simsy-reporting.pages.dev';
  const inviteUrl = `${frontendUrl}/index.html#set-password?token=${inviteToken}`;

  let emailSent = false;
  try {
    await sendInviteEmail({
      to: user.email,
      name: user.display_name,
      inviteUrl,
      apiKey: env.BREVO_API_KEY,
      fromEmail: env.OTP_FROM_EMAIL || 'noreply@s-imsy.com',
    });
    emailSent = true;
  } catch (err) {
    console.error('[ADMIN] Failed to send invite email:', err);
  }

  return jsonResponse({
    status: 'ok',
    message: emailSent ? 'Invite email sent' : 'Failed to send invite email',
    invite_sent: emailSent,
  });
}

/* ================================================================
 * POST /admin/users/:id/reset-password
 * ================================================================ */

export async function handleAdminResetPassword(
  userId: string,
  request: Request,
  sql: postgres.Sql,
  env: Env,
): Promise<Response> {
  let body: { new_password?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON body');
  }

  const { new_password } = body;
  if (!new_password || new_password.length < 12) {
    return errorResponse(400, 'new_password is required and must be at least 12 characters');
  }

  const existing = await sql`SELECT id FROM auth_users WHERE id = ${userId}`;
  if (existing.length === 0) {
    return errorResponse(404, 'User not found');
  }

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
    WHERE id = ${userId}
  `;

  // Revoke all sessions
  const sessions = await sql`
    SELECT token_hash FROM auth_sessions WHERE user_id = ${userId}
  `;
  for (const session of sessions) {
    await env.TENANT_KV.delete(`session:${session.token_hash}`);
  }
  await sql`DELETE FROM auth_sessions WHERE user_id = ${userId}`;

  return jsonResponse({ status: 'ok', message: 'Password reset and all sessions revoked' });
}

/* ================================================================
 * GET /admin/sessions
 * ================================================================ */

export async function handleListSessions(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  env: Env,
  rateLimit: RateLimitResult,
): Promise<Response> {
  const { page, pageSize } = parsePagination(searchParams, env);
  const offset = paginationOffset({ page, pageSize });

  const countResult = await sql`
    SELECT COUNT(*) AS total
    FROM auth_sessions s
    WHERE s.expires_at > now()
  `;
  const total = parseInt(countResult[0].total);

  const rows = await sql`
    SELECT s.id, s.user_id, s.issued_at, s.expires_at, s.last_activity_at,
           s.ip_address, s.user_agent,
           u.email, u.display_name, u.role
    FROM auth_sessions s
    JOIN auth_users u ON u.id = s.user_id
    WHERE s.expires_at > now()
    ORDER BY s.issued_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  const sessions = rows.map((r: Record<string, unknown>) => ({
    id: r.id,
    user_id: r.user_id,
    user_email: r.email,
    user_display_name: r.display_name,
    user_role: r.role,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    last_activity_at: r.last_activity_at,
    ip_address: r.ip_address,
    user_agent: r.user_agent,
  }));

  return paginatedResponse(sessions, total, page, pageSize, rateLimit);
}

/* ================================================================
 * DELETE /admin/sessions/:id
 * ================================================================ */

export async function handleRevokeSession(
  sessionId: string,
  sql: postgres.Sql,
  env: Env,
): Promise<Response> {
  const sessions = await sql`
    SELECT id, token_hash FROM auth_sessions WHERE id = ${sessionId}
  `;

  if (sessions.length === 0) {
    return errorResponse(404, 'Session not found');
  }

  const session = sessions[0];

  // Remove from KV
  await env.TENANT_KV.delete(`session:${session.token_hash}`);
  // Remove from DB
  await sql`DELETE FROM auth_sessions WHERE id = ${sessionId}`;

  return jsonResponse({ status: 'ok', message: 'Session revoked' });
}

/* ================================================================
 * GET /admin/tenants
 * ================================================================ */

export async function handleListTenants(
  sql: postgres.Sql,
): Promise<Response> {
  const rows = await sql`
    SELECT tenant_id, tenant_name, parent_tenant_id, role, is_active
    FROM rpt_tenants
    ORDER BY tenant_name
  `;

  return jsonResponse({ data: rows });
}

