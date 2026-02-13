/**
 * Usage report endpoints.
 *
 * GET /api/v1/usage/summary  — Aggregated usage with daily/monthly/annual grouping
 * GET /api/v1/usage/records  — Paginated raw usage records
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { parsePagination, paginationOffset } from '../utils/pagination';
import { jsonResponse, paginatedResponse, errorResponse } from '../utils/response';

export async function handleUsageSummary(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const groupBy = searchParams.get('group_by') || 'daily';
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!['daily', 'monthly', 'annual'].includes(groupBy)) {
    return errorResponse(400, 'Invalid group_by parameter', 'Must be: daily, monthly, or annual', rateLimit);
  }

  // Select the appropriate materialised view
  const viewMap: Record<string, { view: string; dateCol: string }> = {
    daily: { view: 'mv_usage_daily', dateCol: 'day' },
    monthly: { view: 'mv_usage_monthly', dateCol: 'month' },
    annual: { view: 'mv_usage_annual', dateCol: 'year' },
  };
  const { view, dateCol } = viewMap[groupBy];

  // Build date filter
  let dateFilter = '';
  const params: unknown[] = [tenant.tenant_id];
  let paramIdx = 2;

  if (from) {
    dateFilter += ` AND ${dateCol} >= $${paramIdx}::date`;
    params.push(from);
    paramIdx++;
  }
  if (to) {
    dateFilter += ` AND ${dateCol} <= $${paramIdx}::date`;
    params.push(to);
    paramIdx++;
  }

  // Customer scoping
  let customerFilter = '';
  if (tenant.role === 'customer' && tenant.customer_name) {
    customerFilter = ` AND customer_name = $${paramIdx}`;
    params.push(tenant.customer_name);
    paramIdx++;
  }

  // Get summary totals
  const summaryQuery = `
    SELECT
      COALESCE(SUM(total_consumption), 0) AS total_consumption,
      COALESCE(SUM(total_bytes), 0) AS total_bytes,
      COALESCE(SUM(total_buy), 0) AS total_buy,
      COALESCE(SUM(total_sell), 0) AS total_sell,
      COALESCE(SUM(record_count), 0) AS total_records
    FROM ${view}
    WHERE tenant_id = $1 ${dateFilter} ${customerFilter}
  `;

  const summary = await sql.unsafe(summaryQuery, params);

  // Get grouped data
  const dataQuery = `
    SELECT
      ${dateCol}::text AS date,
      COALESCE(SUM(total_consumption), 0) AS consumption,
      COALESCE(SUM(total_bytes), 0) AS total_bytes,
      COALESCE(SUM(total_buy), 0) AS buy_total,
      COALESCE(SUM(total_sell), 0) AS sell_total,
      COALESCE(SUM(record_count), 0) AS records
    FROM ${view}
    WHERE tenant_id = $1 ${dateFilter} ${customerFilter}
    GROUP BY ${dateCol}
    ORDER BY ${dateCol} ASC
  `;

  const data = await sql.unsafe(dataQuery, params);

  return jsonResponse({
    tenant: tenant.tenant_name,
    period: {
      from: from || 'all',
      to: to || 'now',
      group_by: groupBy,
    },
    summary: {
      total_consumption: Number(summary[0]?.total_consumption || 0),
      total_bytes: Number(summary[0]?.total_bytes || 0),
      total_buy: Number(summary[0]?.total_buy || 0),
      total_sell: Number(summary[0]?.total_sell || 0),
      total_records: Number(summary[0]?.total_records || 0),
    },
    data: data.map((row) => ({
      date: row.date,
      consumption: Number(row.consumption),
      total_bytes: Number(row.total_bytes),
      buy_total: Number(row.buy_total),
      sell_total: Number(row.sell_total),
      records: Number(row.records),
    })),
  }, 200, rateLimit);
}

export async function handleUsageRecords(
  searchParams: URLSearchParams,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  const pagination = parsePagination(searchParams, env);
  const offset = paginationOffset(pagination);
  const iccid = searchParams.get('iccid');
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  // Build filters
  const filters: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenant.tenant_id];
  let paramIdx = 2;

  if (tenant.role === 'customer' && tenant.customer_name) {
    filters.push(`customer_name = $${paramIdx}`);
    params.push(tenant.customer_name);
    paramIdx++;
  }

  if (iccid) {
    filters.push(`iccid = $${paramIdx}`);
    params.push(iccid);
    paramIdx++;
  }

  if (from) {
    filters.push(`timestamp >= $${paramIdx}::timestamptz`);
    params.push(from);
    paramIdx++;
  }

  if (to) {
    filters.push(`timestamp <= $${paramIdx}::timestamptz`);
    params.push(to);
    paramIdx++;
  }

  const whereClause = filters.join(' AND ');

  // Count total
  const countResult = await sql.unsafe(
    `SELECT COUNT(*) AS total FROM rpt_usage WHERE ${whereClause}`,
    params
  );
  const total = Number(countResult[0]?.total || 0);

  // Fetch page
  const dataParams = [...params, pagination.pageSize, offset];
  const data = await sql.unsafe(
    `SELECT
      id, iccid, endpoint_name, endpoint_description, customer_name,
      timestamp, usage_date, service_type, charge_type,
      consumption, charged_consumption, uplink_bytes, downlink_bytes,
      bundle_name, bundle_moniker, status_moniker,
      serving_operator_name, serving_country_name,
      buy_charge, buy_currency, sell_charge, sell_currency
    FROM rpt_usage
    WHERE ${whereClause}
    ORDER BY timestamp DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    dataParams
  );

  return paginatedResponse(data, total, pagination.page, pagination.pageSize, rateLimit);
}
