import { useEffect, useRef, useState } from "react";

export interface ServerListParams {
  limit: number;
  offset: number;
  q?: string;
  sort?: string;
  order: "asc" | "desc";
}

export interface ServerListOptions<T> {
  key: string;
  pageSize?: number;
  initialSort?: string;
  initialOrder?: "asc" | "desc";
  debounceMs?: number;
  fetcher: (params: ServerListParams) => Promise<{ items: T[]; total: number }>;
}

export function useServerList<T>(options: ServerListOptions<T>) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(options.pageSize ?? 20);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(options.initialSort ?? "");
  const [order, setOrder] = useState<"asc" | "desc">(options.initialOrder ?? "asc");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);

  const fetcher = useRef(options.fetcher);
  useEffect(() => {
    fetcher.current = options.fetcher;
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(query);
      setPage(1);
    }, options.debounceMs ?? 250);
    return () => clearTimeout(timer);
  }, [query, options.debounceMs]);

  useEffect(() => {
    setPage(1);
  }, [options.key, pageSize, sort, order]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetcher
      .current({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        q: q || undefined,
        sort: sort || undefined,
        order,
      })
      .then(
        (result) => {
          if (cancelled) return;
          setItems(result.items);
          setTotal(result.total);
          setError("");
        },
        (err: unknown) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, pageSize, q, sort, order, options.key, version]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const rangeStart = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(currentPage * pageSize, total);

  return {
    items,
    total,
    loading,
    error,
    query,
    setQuery,
    page: currentPage,
    pageSize,
    setPage,
    sort,
    setSort,
    order,
    setOrder,
    reload: () => setVersion((current) => current + 1),
    pagination: {
      page: currentPage,
      pageSize,
      total,
      totalPages,
      rangeStart,
      rangeEnd,
      onPageChange: setPage,
      onPageSizeChange: (size: number) => {
        setPageSize(size);
        setPage(1);
      },
    },
  };
}
