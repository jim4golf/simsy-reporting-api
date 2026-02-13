/**
 * Response builder utilities.
 */

import type { PaginatedResponse, ApiError } from '../types';
import { corsHeaders } from '../middleware/cors';
import type { RateLimitResult } from '../middleware/rate-limit';
import { rateLimitHeaders } from '../middleware/rate-limit';

export function jsonResponse(
  data: unknown,
  status: number = 200,
  rateLimit?: RateLimitResult
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...corsHeaders(),
  };

  if (rateLimit) {
    Object.assign(headers, rateLimitHeaders(rateLimit));
  }

  return new Response(JSON.stringify(data), { status, headers });
}

export function paginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  pageSize: number,
  rateLimit?: RateLimitResult
): Response {
  const response: PaginatedResponse<T> = {
    data,
    pagination: {
      page,
      per_page: pageSize,
      total,
      total_pages: Math.ceil(total / pageSize),
    },
  };

  return jsonResponse(response, 200, rateLimit);
}

export function errorResponse(
  status: number,
  message: string,
  detail?: string,
  rateLimit?: RateLimitResult
): Response {
  const error: ApiError = { error: message, status };
  if (detail) error.detail = detail;

  return jsonResponse(error, status, rateLimit);
}
