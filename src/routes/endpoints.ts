/**
 * Endpoint report routes.
 *
 * GET /api/v1/endpoints                    — List all endpoints for tenant
 * GET /api/v1/endpoints/:id/usage          — Usage data for a specific endpoint
 * GET /api/v1/endpoints/top                — Top endpoints by avg monthly usage with monthly breakdown
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { tenantFilter } from '../db';
import { parsePagination, paginationOffset } from '../utils/pagination';
import { paginatedResponse, jsonResponse, errorResponse } from '../utils/response';

export async function handleEndpointsList(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const pagination = parsePagination(searchParams, env);
  const offset = paginationOffset(pagination);
  const status = searchParams.get('status');
  const search = searchParams.get('search');

  const tf = tenantFilter(tenant);
  const filters: string[] = [tf.clause];
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;

  // Admin scoping: allow explicit tenant_id filter
  if (tenant.role === 'admin' && searchParams.get('tenant_id')) {
    filters.push(`tenant_id = $${paramIdx}`);
    params.push(searchParams.get('tenant_id'));
    paramIdx++;
  }

  if (tenant.role === 'customer' && tenant.customer_id) {
    filters.push(`customer_id = $${paramIdx}`);
    params.push(tenant.customer_id);
    paramIdx++;
  } else if (searchParams.get('customer')) {
    // rpt_endpoints has customer_id but not customer_name;
    // resolve via rpt_bundle_instances which has both
    filters.push(`endpoint_name IN (SELECT DISTINCT endpoint_name FROM rpt_bundle_instances WHERE customer_name = $${paramIdx} AND endpoint_name IS NOT NULL)`);
    params.push(searchParams.get('customer'));
    paramIdx++;
  }

  if (status) {
    filters.push(`(LOWER(status) = LOWER($${paramIdx}) OR LOWER(endpoint_status_name) = LOWER($${paramIdx}))`);
    params.push(status);
    paramIdx++;
  }

  if (search) {
    // Search by endpoint name, source_id, OR ICCID (via bundle instances join)
    filters.push(`(endpoint_name ILIKE $${paramIdx} OR source_id ILIKE $${paramIdx} OR endpoint_name IN (SELECT DISTINCT endpoint_name FROM rpt_bundle_instances WHERE iccid ILIKE $${paramIdx} AND endpoint_name IS NOT NULL))`);
    params.push(`%${search}%`);
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  const countResult = await sql.unsafe(
    `SELECT COUNT(*) AS total FROM rpt_endpoints WHERE ${whereClause}`,
    params
  );
  const total = Number(countResult[0]?.total || 0);

  const dataParams = [...params, pagination.pageSize, offset];
  const data = await sql.unsafe(
    `SELECT
      id, source_id AS endpoint_identifier, endpoint_name, endpoint_type, endpoint_type_name,
      status, endpoint_status_name, network_status_name,
      usage_rolling_24h, usage_rolling_7d, usage_rolling_28d, usage_rolling_1y,
      charge_rolling_24h, charge_rolling_7d, charge_rolling_28d, charge_rolling_1y,
      first_activity, latest_activity
    FROM rpt_endpoints
    WHERE ${whereClause}
    ORDER BY
      CASE WHEN COALESCE(usage_rolling_28d, 0) = 0 AND COALESCE(usage_rolling_1y, 0) = 0 THEN 1 ELSE 0 END,
      CASE WHEN COALESCE(usage_rolling_28d, 0) = 0 AND COALESCE(usage_rolling_1y, 0) = 0 THEN LENGTH(COALESCE(endpoint_name, '')) END DESC,
      endpoint_name ASC NULLS LAST
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return paginatedResponse(data, total, pagination.page, pagination.pageSize, rateLimit);
}

export async function handleEndpointUsage(
  endpointId: string,
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  // Verify endpoint belongs to tenant (RLS handles scoping for admins)
  const tfLookup = tenantFilter(tenant);
  const lookupParams: unknown[] = [...tfLookup.params, endpointId, endpointId];
  const endpoints = await sql.unsafe(
    `SELECT endpoint_name FROM rpt_endpoints
    WHERE ${tfLookup.clause}
      AND (id::text = $${tfLookup.nextIdx} OR source_id = $${tfLookup.nextIdx + 1})
    LIMIT 1`,
    lookupParams
  );

  if (endpoints.length === 0) {
    return errorResponse(404, 'Endpoint not found', undefined, rateLimit);
  }

  const endpointName = endpoints[0].endpoint_name;
  const groupBy = searchParams.get('group_by') || 'daily';
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!['daily', 'monthly', 'annual'].includes(groupBy)) {
    return errorResponse(400, 'Invalid group_by parameter', undefined, rateLimit);
  }

  // Query usage data grouped by the selected period
  const dateFunc = groupBy === 'daily' ? 'day' : groupBy === 'monthly' ? 'month' : 'year';
  const truncFunc = groupBy === 'daily'
    ? 'usage_date'
    : `date_trunc('${dateFunc === 'month' ? 'month' : 'year'}', usage_date)::date`;

  const tfUsage = tenantFilter(tenant);
  const filters: string[] = [
    tfUsage.clause,
    `endpoint_name = $${tfUsage.nextIdx}`,
  ];
  const params: unknown[] = [...tfUsage.params, endpointName];
  let paramIdx = tfUsage.nextIdx + 1;

  // Admin scoping: allow explicit tenant_id filter
  if (tenant.role === 'admin' && searchParams.get('tenant_id')) {
    filters.push(`tenant_id = $${paramIdx}`);
    params.push(searchParams.get('tenant_id'));
    paramIdx++;
  }

  if (tenant.role === 'customer' && tenant.customer_name) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(tenant.customer_name);
    paramIdx++;
  } else if (searchParams.get('customer')) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(searchParams.get('customer'));
    paramIdx++;
  }

  if (from) {
    filters.push(`usage_date >= $${paramIdx}::date`);
    params.push(from);
    paramIdx++;
  }

  if (to) {
    filters.push(`usage_date <= $${paramIdx}::date`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  const data = await sql.unsafe(
    `SELECT
      ${truncFunc} AS date,
      SUM(consumption) AS consumption,
      SUM(uplink_bytes + downlink_bytes) AS total_bytes,
      SUM(buy_charge) AS buy_total,
      SUM(sell_charge) AS sell_total,
      COUNT(*) AS records
    FROM rpt_usage
    WHERE ${whereClause}
    GROUP BY ${truncFunc}
    ORDER BY ${truncFunc} ASC`,
    params
  );

  return jsonResponse({
    endpoint: endpointName,
    endpoint_id: endpointId,
    period: { from: from || 'all', to: to || 'now', group_by: groupBy },
    data: data.map((row) => ({
      date: row.date,
      consumption: Number(row.consumption || 0),
      total_bytes: Number(row.total_bytes || 0),
      buy_total: Number(row.buy_total || 0),
      sell_total: Number(row.sell_total || 0),
      records: Number(row.records || 0),
    })),
  }, 200, rateLimit);
}

/**
 * GET /api/v1/endpoints/top — Top endpoints ranked by average monthly usage.
 * Returns each endpoint's monthly usage breakdown so the frontend can chart
 * month-by-month usage lines.
 *
 * Query params: limit (default 5), tenant_id, customer
 */
export async function handleTopEndpoints(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const limit = parseInt(searchParams.get('limit') || '5', 10);

  const tf = tenantFilter(tenant);
  const filters: string[] = [tf.clause];
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;

  if (tenant.role === 'admin' && searchParams.get('tenant_id')) {
    filters.push(`tenant_id = $${paramIdx}`);
    params.push(searchParams.get('tenant_id'));
    paramIdx++;
  }

  if (tenant.role === 'customer' && tenant.customer_name) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(tenant.customer_name);
    paramIdx++;
  } else if (searchParams.get('customer')) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(searchParams.get('customer'));
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  // Step 1: Find top N endpoints by average monthly charged_consumption.
  // Average = total usage / number of distinct active months.
  const topParams = [...params, limit];
  const topEndpoints = await sql.unsafe(`
    SELECT
      endpoint_name,
      SUM(charged_consumption) AS total_bytes,
      COUNT(DISTINCT date_trunc('month', usage_date)) AS active_months,
      CASE WHEN COUNT(DISTINCT date_trunc('month', usage_date)) > 0
           THEN SUM(charged_consumption) / COUNT(DISTINCT date_trunc('month', usage_date))
           ELSE 0
      END AS avg_monthly_bytes
    FROM rpt_usage
    WHERE ${whereClause}
      AND endpoint_name IS NOT NULL
      AND charged_consumption > 0
    GROUP BY endpoint_name
    ORDER BY avg_monthly_bytes DESC
    LIMIT $${paramIdx}
  `, topParams);

  if (topEndpoints.length === 0) {
    return jsonResponse({ endpoints: [] }, 200, rateLimit);
  }

  // Step 2: Get monthly breakdown for these endpoints
  const endpointNames = topEndpoints.map((r: { endpoint_name: string }) => r.endpoint_name);
  // Build IN clause with parameterised values
  const inPlaceholders = endpointNames.map((_: string, i: number) => `$${paramIdx + i}`).join(',');
  const monthlyParams = [...params, ...endpointNames];

  const monthlyData = await sql.unsafe(`
    SELECT
      endpoint_name,
      date_trunc('month', usage_date)::date::text AS month,
      SUM(charged_consumption) AS total_bytes
    FROM rpt_usage
    WHERE ${whereClause}
      AND endpoint_name IN (${inPlaceholders})
      AND charged_consumption > 0
    GROUP BY endpoint_name, date_trunc('month', usage_date)
    ORDER BY date_trunc('month', usage_date) ASC
  `, monthlyParams);

  // Group monthly data by endpoint
  const monthlyByEndpoint: Record<string, Record<string, number>> = {};
  for (const row of monthlyData) {
    const ep = row.endpoint_name as string;
    if (!monthlyByEndpoint[ep]) monthlyByEndpoint[ep] = {};
    monthlyByEndpoint[ep][row.month as string] = Number(row.total_bytes);
  }

  // Build response with endpoints ordered by avg monthly usage
  const endpoints = topEndpoints.map((r: { endpoint_name: string; total_bytes: string; active_months: string; avg_monthly_bytes: string }) => ({
    endpoint_name: r.endpoint_name,
    total_bytes: Number(r.total_bytes),
    active_months: Number(r.active_months),
    avg_monthly_bytes: Number(r.avg_monthly_bytes),
    monthly: monthlyByEndpoint[r.endpoint_name] || {},
  }));

  return jsonResponse({ endpoints }, 200, rateLimit);
}
