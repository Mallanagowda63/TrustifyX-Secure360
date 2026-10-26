"use client";

/** Reads the double-submit CSRF cookie set at login. */
function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)(?:__Host-)?tx_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export class ClientApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrfToken() } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = (data as { issues?: Array<{ path: string; message: string }> }).issues;
    const msg = issues?.length ? issues.map((i) => i.message).join("; ") : (data as { error?: string }).error;
    throw new ClientApiError(res.status, msg ?? `Request failed (${res.status})`, (data as { code?: string }).code, issues);
  }
  return data as T;
}
