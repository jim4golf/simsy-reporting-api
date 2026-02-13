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
import { errorResponse } from './utils/response';

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
