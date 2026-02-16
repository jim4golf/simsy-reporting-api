/**
 * URL router for the Reporting API.
 * Maps URL paths to route handlers.
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from './types';
import type { RateLimitResult } from './middleware/rate-limit';
import { handleUsageSummary, handleUsageRecords } from './routes/usage';
import { handleBundlesList, handleBundleDetail } from './routes/bundles';
import { handleInstancesList } from './routes/instances';
import { handleEndpointsList, handleEndpointUsage } from './routes/endpoints';
import { handleExport } from './routes/export';
import { handleLogout, handleMe } from './routes/auth';
import {
  handleListUsers,
  handleCreateUser,
  handleGetUser,
  handleUpdateUser,
  handleDeleteUser,
  handleAdminResetPassword,
  handleListSessions,
  handleRevokeSession,
  handleListTenants,
} from './routes/admin';
import { requireAdmin } from './middleware/admin-guard';
import { errorResponse } from './utils/response';

/**
 * Route authenticated requests.
 * Called AFTER authentication succeeds (tenant is guaranteed non-null).
 */
export async function routeRequest(
  request: Request,
  url: URL,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const path = url.pathname;
  const searchParams = url.searchParams;
  const method = request.method;

  // Strip the /api/v1 prefix
  const apiPath = path.replace(/^\/api\/v1/, '');

  // ── Auth routes (authenticated) ──────────────────────────────────

  if (method === 'POST' && apiPath === '/auth/logout') {
    return handleLogout(request, sql, env, tenant);
  }

  if (method === 'GET' && apiPath === '/auth/me') {
    return handleMe(sql, tenant);
  }

  // ── Admin routes (require admin role) ────────────────────────────

  if (apiPath.startsWith('/admin/')) {
    const forbidden = requireAdmin(tenant);
    if (forbidden) return forbidden;

    return routeAdminRequest(request, url, sql, apiPath, tenant, env, rateLimit);
  }

  // ── Data routes (existing) ──────────────────────────────────────

  // GET /api/v1/usage/summary
  if (method === 'GET' && apiPath === '/usage/summary') {
    return handleUsageSummary(searchParams, sql, tenant, env, rateLimit);
  }

  // GET /api/v1/usage/records
  if (method === 'GET' && apiPath === '/usage/records') {
    return handleUsageRecords(searchParams, sql, tenant, env, rateLimit);
  }

  // GET /api/v1/bundles
  if (method === 'GET' && apiPath === '/bundles') {
    return handleBundlesList(searchParams, sql, tenant, env, rateLimit);
  }

  // GET /api/v1/bundles/:id
  const bundleMatch = apiPath.match(/^\/bundles\/([^/]+)$/);
  if (method === 'GET' && bundleMatch) {
    return handleBundleDetail(bundleMatch[1], sql, tenant, rateLimit);
  }

  // GET /api/v1/bundle-instances
  if (method === 'GET' && apiPath === '/bundle-instances') {
    return handleInstancesList(searchParams, sql, tenant, env, rateLimit);
  }

  // GET /api/v1/endpoints
  if (method === 'GET' && apiPath === '/endpoints') {
    return handleEndpointsList(searchParams, sql, tenant, env, rateLimit);
  }

  // GET /api/v1/endpoints/:id/usage
  const endpointUsageMatch = apiPath.match(/^\/endpoints\/([^/]+)\/usage$/);
  if (method === 'GET' && endpointUsageMatch) {
    return handleEndpointUsage(endpointUsageMatch[1], searchParams, sql, tenant, env, rateLimit);
  }

  // POST /api/v1/export
  if (method === 'POST' && apiPath === '/export') {
    return handleExport(request, sql, tenant, env, rateLimit);
  }

  return errorResponse(404, 'Not Found', `No route matches ${method} ${path}`, rateLimit);
}

/**
 * Route admin sub-requests.
 */
async function routeAdminRequest(
  request: Request,
  url: URL,
  sql: postgres.Sql,
  apiPath: string,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult,
): Promise<Response> {
  const method = request.method;
  const searchParams = url.searchParams;

  // GET /admin/users
  if (method === 'GET' && apiPath === '/admin/users') {
    return handleListUsers(searchParams, sql, tenant, env, rateLimit);
  }

  // POST /admin/users
  if (method === 'POST' && apiPath === '/admin/users') {
    return handleCreateUser(request, sql, tenant, env);
  }

  // GET /admin/tenants
  if (method === 'GET' && apiPath === '/admin/tenants') {
    return handleListTenants(sql);
  }

  // GET /admin/sessions
  if (method === 'GET' && apiPath === '/admin/sessions') {
    return handleListSessions(searchParams, sql, env, rateLimit);
  }

  // Routes with :id parameter

  // POST /admin/users/:id/reset-password
  const resetMatch = apiPath.match(/^\/admin\/users\/([^/]+)\/reset-password$/);
  if (method === 'POST' && resetMatch) {
    return handleAdminResetPassword(resetMatch[1], request, sql, env);
  }

  // DELETE /admin/sessions/:id
  const sessionDeleteMatch = apiPath.match(/^\/admin\/sessions\/([^/]+)$/);
  if (method === 'DELETE' && sessionDeleteMatch) {
    return handleRevokeSession(sessionDeleteMatch[1], sql, env);
  }

  // GET /admin/users/:id
  const userGetMatch = apiPath.match(/^\/admin\/users\/([^/]+)$/);
  if (method === 'GET' && userGetMatch) {
    return handleGetUser(userGetMatch[1], sql);
  }

  // PUT /admin/users/:id
  const userUpdateMatch = apiPath.match(/^\/admin\/users\/([^/]+)$/);
  if (method === 'PUT' && userUpdateMatch) {
    return handleUpdateUser(userUpdateMatch[1], request, sql);
  }

  // DELETE /admin/users/:id
  const userDeleteMatch = apiPath.match(/^\/admin\/users\/([^/]+)$/);
  if (method === 'DELETE' && userDeleteMatch) {
    return handleDeleteUser(userDeleteMatch[1], sql, env, tenant);
  }

  return errorResponse(404, 'Not Found', `No admin route matches ${method} ${apiPath}`, rateLimit);
}

/**
 * Route public auth requests (no authentication required).
 * Called from index.ts BEFORE the main auth check.
 */
export { handleLogin, handleVerifyOTP, handleForgotPassword, handleResetPassword } from './routes/auth';
