/**
 * Pagination utilities.
 */

import type { Env, PaginationParams } from '../types';

export function parsePagination(
  searchParams: URLSearchParams,
  env: Env
): PaginationParams {
  const defaultSize = parseInt(env.DEFAULT_PAGE_SIZE || '100', 10);
  const maxSize = parseInt(env.MAX_PAGE_SIZE || '1000', 10);

  let page = parseInt(searchParams.get('page') || '1', 10);
  let pageSize = parseInt(searchParams.get('per_page') || String(defaultSize), 10);

  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(pageSize) || pageSize < 1) pageSize = defaultSize;
  if (pageSize > maxSize) pageSize = maxSize;

  return { page, pageSize };
}

export function paginationOffset(params: PaginationParams): number {
  return (params.page - 1) * params.pageSize;
}
