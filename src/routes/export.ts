/**
 * Data export endpoint.
 *
 * POST /api/v1/export — Generate CSV or JSON export of reporting data
 *
 * Streams the response directly — no intermediate storage needed.
 */

import type postgres from 'postgres';
import type { Env, TenantInfo } from '../types';
import type { RateLimitResult } from '../middleware/rate-limit';
import { tenantFilter } from '../db';
import { errorResponse } from '../utils/response';
import { corsHeaders } from '../middleware/cors';
import { rateLimitHeaders } from '../middleware/rate-limit';

interface ExportRequest {
  report_type: 'usage' | 'bundles' | 'instances' | 'endpoints';
  format: 'csv' | 'json';
  from?: string;
  to?: string;
  filters?: {
    iccid?: string;
    endpoint_id?: string;
  };
}

export async function handleExport(
  request: Request,
  sql: postgres.Sql,
  tenant: TenantInfo,
  env: Env,
  rateLimit: RateLimitResult
): Promise<Response> {
  let body: ExportRequest;
  try {
    body = await request.json() as ExportRequest;
  } catch {
    return errorResponse(400, 'Invalid JSON body', undefined, rateLimit);
  }

  const { report_type, format, from, to, filters } = body;

  if (!report_type || !['usage', 'bundles', 'instances', 'endpoints'].includes(report_type)) {
    return errorResponse(400, 'Invalid report_type', 'Must be: usage, bundles, instances, or endpoints', rateLimit);
  }

  if (!format || !['csv', 'json'].includes(format)) {
    return errorResponse(400, 'Invalid format', 'Must be: csv or json', rateLimit);
  }

  // Build query based on report type
  let query: string;
  const tf = tenantFilter(tenant);
  const params: unknown[] = [...tf.params];
  let paramIdx = tf.nextIdx;

  let customerFilter = '';
  if (tenant.role === 'customer' && tenant.customer_name) {
    customerFilter = ` AND customer_name = $${paramIdx}`;
    params.push(tenant.customer_name);
    paramIdx++;
  }

  let dateFilter = '';
  if (from && report_type === 'usage') {
    dateFilter += ` AND timestamp >= $${paramIdx}::timestamptz`;
    params.push(from);
    paramIdx++;
  }
  if (to && report_type === 'usage') {
    dateFilter += ` AND timestamp <= $${paramIdx}::timestamptz`;
    params.push(to);
    paramIdx++;
  }

  let extraFilter = '';
  if (filters?.iccid && ['usage', 'instances'].includes(report_type)) {
    extraFilter += ` AND iccid = $${paramIdx}`;
    params.push(filters.iccid);
    paramIdx++;
  }

  switch (report_type) {
    case 'usage':
      query = `
        SELECT
          iccid, endpoint_name, customer_name,
          timestamp, usage_date, service_type, charge_type,
          consumption, charged_consumption, uplink_bytes, downlink_bytes,
          bundle_name, bundle_moniker, status_moniker,
          serving_operator_name, serving_country_name,
          buy_charge, buy_currency, sell_charge, sell_currency
        FROM rpt_usage
        WHERE ${tf.clause} ${customerFilter} ${dateFilter} ${extraFilter}
        ORDER BY timestamp DESC
      `;
      break;

    case 'bundles':
      query = `
        SELECT
          source_id AS bundle_id, bundle_name, bundle_moniker,
          price, currency, allowance, allowance_moniker,
          status_name, effective_from, effective_to
        FROM rpt_bundles
        WHERE ${tf.clause} ${customerFilter}
        ORDER BY bundle_name ASC
      `;
      break;

    case 'instances':
      query = `
        SELECT
          iccid, customer_name, endpoint_name,
          bundle_name, bundle_moniker, bundle_instance_id,
          start_time, end_time, status_name, status_moniker,
          sequence, sequence_max, data_used_mb, data_allowance_mb
        FROM rpt_bundle_instances
        WHERE ${tf.clause} ${customerFilter} ${extraFilter}
        ORDER BY start_time DESC
      `;
      break;

    case 'endpoints':
      query = `
        SELECT
          source_id AS endpoint_identifier, endpoint_name, endpoint_type,
          status, endpoint_status_name,
          usage_rolling_24h, usage_rolling_7d, usage_rolling_28d, usage_rolling_1y,
          charge_rolling_24h, charge_rolling_7d, charge_rolling_28d, charge_rolling_1y,
          first_activity, latest_activity
        FROM rpt_endpoints
        WHERE ${tf.clause} ${customerFilter}
        ORDER BY endpoint_name ASC
      `;
      break;
  }

  // Execute query
  const data = await sql.unsafe(query, params);

  if (format === 'json') {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${report_type}_export.json"`,
      ...corsHeaders(),
      ...rateLimitHeaders(rateLimit),
    };

    return new Response(JSON.stringify({
      export: {
        report_type,
        tenant: tenant.tenant_name,
        exported_at: new Date().toISOString(),
        record_count: data.length,
        filters: { from, to, ...filters },
      },
      data,
    }, null, 2), { headers });
  }

  // CSV format
  if (data.length === 0) {
    return new Response('No data found for the specified criteria.\n', {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${report_type}_export.csv"`,
        ...corsHeaders(),
        ...rateLimitHeaders(rateLimit),
      },
    });
  }

  const columns = Object.keys(data[0]);
  const csvLines: string[] = [columns.join(',')];

  for (const row of data) {
    const values = columns.map((col) => {
      const val = (row as Record<string, unknown>)[col];
      if (val === null || val === undefined) return '';
      const str = String(val);
      // Escape CSV: quote if contains comma, quote, or newline
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    csvLines.push(values.join(','));
  }

  return new Response(csvLines.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${report_type}_export.csv"`,
      ...corsHeaders(),
      ...rateLimitHeaders(rateLimit),
    },
  });
}
