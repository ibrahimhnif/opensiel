export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body: unknown = undefined,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    const detail = parsed as { message?: string } | undefined;
    if (detail?.message) message = detail.message;
    else if (text) message = text.slice(0, 300);
    throw new ApiError(response.status, message, parsed);
  }
  return parsed as T;
}

const jsonHeaders = { "content-type": "application/json" };

function jsonRequest(method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: jsonHeaders, body: JSON.stringify(body) };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, jsonRequest("POST", body)),
  patch: <T>(path: string, body?: unknown) => request<T>(path, jsonRequest("PATCH", body)),
  put: <T>(path: string, body?: unknown) => request<T>(path, jsonRequest("PUT", body)),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
