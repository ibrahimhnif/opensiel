import { z } from "zod";

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(50).optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});

export type PaginationQuery = z.input<typeof paginationSchema>;

export function paginate<T>(rows: T[], query: PaginationQuery) {
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;
  return {
    items: rows.slice(offset, offset + limit),
    total: rows.length,
    limit,
    offset,
  };
}

type SortValue = string | number | null | undefined;

export function sortRows<T>(
  rows: T[],
  query: PaginationQuery,
  getters: Record<string, (row: T) => SortValue>,
): T[] {
  const getter = query.sort ? getters[query.sort] : undefined;
  if (!getter) return rows;
  const factor = (query.order ?? "asc") === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = getter(left);
    const b = getter(right);
    if (a === b) return 0;
    if (a === null || a === undefined) return 1;
    if (b === null || b === undefined) return -1;
    return (a < b ? -1 : 1) * factor;
  });
}

export function contains(value: string | null | undefined, needle: string): boolean {
  return (value ?? "").toLowerCase().includes(needle);
}
