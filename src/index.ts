/**
 * S-IMSY Reporting API Worker
 *
 * Cloudflare Worker that serves the REST API for the reporting platform.
 * Authenticates users via JWT (browser) or Cloudflare Access service tokens (API),
 * enforces Row-Level Security per request, and returns JSON responses.
 *
 * Base path: /api/v1/
 *
 * Public routes (no auth required):
 *   POST /api/v1/auth/login            — Email + password → OTP
 *   POST /api/v1/auth/verify-otp       — OTP → JWT
 *   POST /api/v1/auth/forgot-password  — Send password reset OTP
 *   POST /api/v1/auth/reset-password   — Verify OTP + set new password
 *
 * Protected routes:
 *   GET  /api/v1/auth/me               — Current user profile
 *   POST /api/v1/auth/logout           — Invalidate session
 *   GET  /api/v1/usage/summary         — Aggregated usage data
 *   GET  /api/v1/usage/records         — Paginated usage records
 *   GET  /api/v1/bundles               — List active bundles
 *   GET  /api/v1/bundles/:id           — Bundle detail with instances
 *   GET  /api/v1/bundle-instances      — List bundle instances
 *   GET  /api/v1/endpoints             — List endpoints
 *   GET  /api/v1/endpoints/:id/usage   — Endpoint-specific usage
 *   POST /api/v1/export                — Bulk data export (CSV/JSON)
 *
 * Admin routes (require admin role + JWT):
 *   GET    /api/v1/admin/users                   — List users
 *   POST   /api/v1/admin/users                   — Create user
 *   GET    /api/v1/admin/users/:id               — User detail
 *   PUT    /api/v1/admin/users/:id               — Update user
 *   DELETE /api/v1/admin/users/:id               — Deactivate user
 *   POST   /api/v1/admin/users/:id/reset-password — Reset password
 *   POST   /api/v1/admin/users/:id/resend-invite — Re-send invite email
 *   GET    /api/v1/admin/sessions                — Active sessions
 *   DELETE /api/v1/admin/sessions/:id            — Revoke session
 *   GET    /api/v1/admin/tenants                 — List tenants
 */

import type { Env } from './types';
import { authenticateTenant } from './auth';
import { createDbClient, withTenantContext } from './db';
import { handleOptions, corsHeaders } from './middleware/cors';
import { checkRateLimit } from './middleware/rate-limit';
import {
  routeRequest,
  handleLogin,
  handleVerifyOTP,
  handleForgotPassword,
  handleResetPassword,
  handleAcceptInvite,
} from './router';
import { errorResponse, jsonResponse } from './utils/response';

/** Auth paths that do NOT require authentication */
const PUBLIC_AUTH_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/verify-otp',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/accept-invite',
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return jsonResponse({
        service: 'simsy-reporting-api',
        version: env.API_VERSION,
        status: 'healthy',
        timestamp: new Date().toISOString(),
      });
    }

    // API info
    if (url.pathname === '/api' || url.pathname === '/api/v1') {
      return jsonResponse({
        name: 'S-IMSY Reporting API',
        version: env.API_VERSION,
        base_url: `${url.origin}/api/v1`,
        endpoints: [
          { method: 'POST', path: '/api/v1/auth/login', description: 'Email + password login' },
          { method: 'POST', path: '/api/v1/auth/verify-otp', description: 'Verify 2FA code' },
          { method: 'GET', path: '/api/v1/usage/summary', description: 'Aggregated usage data' },
          { method: 'GET', path: '/api/v1/usage/records', description: 'Paginated usage records' },
          { method: 'GET', path: '/api/v1/bundles', description: 'List active bundles' },
          { method: 'GET', path: '/api/v1/bundles/:id', description: 'Bundle detail with instances' },
          { method: 'GET', path: '/api/v1/bundle-instances', description: 'List bundle instances' },
          { method: 'GET', path: '/api/v1/endpoints', description: 'List endpoints' },
          { method: 'GET', path: '/api/v1/endpoints/:id/usage', description: 'Endpoint-specific usage' },
          { method: 'POST', path: '/api/v1/export', description: 'Bulk data export (CSV/JSON)' },
        ],
        authentication: {
          methods: [
            { type: 'Bearer JWT', description: 'Login via /auth/login + /auth/verify-otp' },
            { type: 'Service Token', headers: ['CF-Access-Client-Id'], description: 'Cloudflare Access service token' },
          ],
        },
      });
    }

    // All /api/v1/* routes
    if (!url.pathname.startsWith('/api/v1/')) {
      return errorResponse(404, 'Not Found', 'API routes are under /api/v1/');
    }

    // ── Public auth routes (no authentication required) ─────────────

    if (PUBLIC_AUTH_PATHS.has(url.pathname) && request.method === 'POST') {
      const sql = createDbClient(env);
      try {
        return await routePublicAuth(request, url, sql, env);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[AUTH] Error processing ${url.pathname}: ${msg}`);
        return errorResponse(500, 'Internal Server Error', msg);
      } finally {
        await sql.end();
      }
    }

    // ── Authenticated routes ────────────────────────────────────────

    // Authenticate tenant (JWT or service token)
    const tenant = await authenticateTenant(request, env);
    if (!tenant) {
      return errorResponse(401, 'Unauthorized', 'Invalid or missing authentication');
    }

    // Rate limiting
    const isExport = url.pathname.endsWith('/export') && request.method === 'POST';
    const weight = isExport ? 5 : 1;
    const rateLimit = await checkRateLimit(env, tenant.tenant_id, weight);

    if (!rateLimit.allowed) {
      return errorResponse(429, 'Rate Limit Exceeded',
        `Rate limit of ${rateLimit.limit} requests per minute exceeded. Reset at ${new Date(rateLimit.resetAt * 1000).toISOString()}`,
        rateLimit
      );
    }

    // Connect to database and run query within a transaction with RLS context
    const sql = createDbClient(env);

    try {
      // Admin routes run queries on auth tables (no RLS), but also need
      // tenant context for data-scoped queries. We always set the context.
      const response = await withTenantContext(sql, tenant, async (tx) => {
        return await routeRequest(request, url, tx, tenant, env, rateLimit);
      });

      return response;

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[API] Error processing ${url.pathname}: ${msg}`);

      if (msg.includes('timeout') || msg.includes('TIMEOUT')) {
        return errorResponse(504, 'Gateway Timeout', 'The query took too long to process', rateLimit);
      }

      return errorResponse(500, 'Internal Server Error', msg, rateLimit);

    } finally {
      // Always close the connection
      await sql.end();
    }
  },
};

/**
 * Route public (unauthenticated) auth requests.
 * These get a raw SQL connection with no RLS context.
 */
async function routePublicAuth(
  request: Request,
  url: URL,
  sql: ReturnType<typeof createDbClient>,
  env: Env,
): Promise<Response> {
  switch (url.pathname) {
    case '/api/v1/auth/login':
      return handleLogin(request, sql, env);
    case '/api/v1/auth/verify-otp':
      return handleVerifyOTP(request, sql, env);
    case '/api/v1/auth/forgot-password':
      return handleForgotPassword(request, sql, env);
    case '/api/v1/auth/reset-password':
      return handleResetPassword(request, sql, env);
    case '/api/v1/auth/accept-invite':
      return handleAcceptInvite(request, sql, env);
    default:
      return errorResponse(404, 'Not Found');
  }
}
