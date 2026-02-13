/**
 * Endpoint report routes.
 *
 * GET /api/v1/endpoints                    — List all endpoints for tenant
 * GET /api/v1/endpoints/:id/usage          — Usage data for a specific endpoint
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
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

  const filters: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenant.tenant_id];
  let paramIdx = 2;

  if (tenant.role === 'customer' && tenant.customer_id) {
    filters.push(`customer_id = $${paramIdx}`);
    params.push(tenant.customer_id);
    paramIdx++;
  }

  if (status) {
    filters.push(`(LOWER(status) = LOWER($${paramIdx}) OR LOWER(endpoint_status_name) = LOWER($${paramIdx}))`);
    params.push(status);
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
    ORDER BY endpoint_name ASC NULLS LAST
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
  // Verify endpoint belongs to tenant
  const endpoints = await sql`
    SELECT endpoint_name FROM rpt_endpoints
    WHERE tenant_id = ${tenant.tenant_id}
      AND (id::text = ${endpointId} OR source_id = ${endpointId})
    LIMIT 1
  `;

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

  const filters: string[] = [
    'tenant_id = $1',
    'endpoint_name = $2',
  ];
  const params: unknown[] = [tenant.tenant_id, endpointName];
  let paramIdx = 3;

  if (tenant.role === 'customer' && tenant.customer_name) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(tenant.customer_name);
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
