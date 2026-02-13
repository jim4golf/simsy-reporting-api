/**
 * S-IMSY Reporting API Worker
 *
 * Cloudflare Worker that serves the REST API for the reporting platform.
 * Authenticates tenants via Cloudflare Access service tokens,
 * enforces Row-Level Security per request, and returns JSON responses.
 *
 * Base path: /api/v1/
 *
 * Routes:
 *   GET  /api/v1/usage/summary           — Aggregated usage data
 *   GET  /api/v1/usage/records            — Paginated usage records
 *   GET  /api/v1/bundles                  — List active bundles
 *   GET  /api/v1/bundles/:id              — Bundle detail with instances
 *   GET  /api/v1/bundle-instances         — List bundle instances
 *   GET  /api/v1/endpoints                — List endpoints
 *   GET  /api/v1/endpoints/:id/usage      — Endpoint-specific usage
 *   POST /api/v1/export                   — Bulk data export (CSV/JSON)
 */

import type { Env } from './types';
import { authenticateTenant } from './auth';
import { createDbClient, withTenantContext } from './db';
import { handleOptions, corsHeaders } from './middleware/cors';
import { checkRateLimit } from './middleware/rate-limit';
import { routeRequest } from './router';
import { errorResponse, jsonResponse } from './utils/response';

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
          type: 'Service Token',
          headers: ['CF-Access-Client-Id'],
        },
      });
    }

    // All /api/v1/* routes require authentication
    if (!url.pathname.startsWith('/api/v1/')) {
      return errorResponse(404, 'Not Found', 'API routes are under /api/v1/');
    }

    // Authenticate tenant
    const tenant = await authenticateTenant(request, env);
    if (!tenant) {
      return errorResponse(401, 'Unauthorized', 'Invalid or missing service token');
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
      // withTenantContext wraps everything in BEGIN...COMMIT so that
      // SET LOCAL app.current_tenant takes effect for all queries
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
