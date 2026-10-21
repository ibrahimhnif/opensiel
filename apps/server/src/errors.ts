import type { z } from "zod";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "error",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string) => new AppError(400, message, "bad_request");
export const unauthorized = (message = "authentication required") =>
  new AppError(401, message, "unauthorized");
export const forbidden = (message = "not allowed") => new AppError(403, message, "forbidden");
export const notFound = (message = "not found") => new AppError(404, message, "not_found");
export const conflict = (message: string) => new AppError(409, message, "conflict");

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    throw badRequest(message);
  }
  return result.data;
}
