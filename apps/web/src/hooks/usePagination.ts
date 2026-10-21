import { useEffect, useMemo, useState } from "react";

export interface PaginationOptions {
  pageSize?: number;
  resetKey?: string;
}

export function usePagination<T>(items: T[], options: PaginationOptions = {}) {
  const [pageSize, setPageSize] = useState(options.pageSize ?? 20);
  const [page, setPage] = useState(1);
  const resetKey = options.resetKey ?? "";

  useEffect(() => {
    setPage(1);
  }, [resetKey, pageSize]);

  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rangeStart = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, total);

  const pageItems = useMemo(
    () => items.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [items, currentPage, pageSize],
  );

  return {
    page: currentPage,
    pageSize,
    setPage,
    setPageSize,
    total,
    totalPages,
    pageItems,
    rangeStart,
    rangeEnd,
  };
}
