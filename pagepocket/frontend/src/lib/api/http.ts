import "server-only";
import type { cookies } from "next/headers";
import type { ZodType } from "zod";
import { ZodError } from "zod";
import { ApiContractError, NetworkError, throwForStatus } from "./errors";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080/api/v1";

type ServerFetchOptions<T> = {
  route: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  schema: ZodType<T>;
  cookieStore: Awaited<ReturnType<typeof cookies>>;
  token?: string;
};

export async function serverFetch<T>({
  route,
  method = "GET",
  body,
  query,
  schema,
  cookieStore,
  token,
}: ServerFetchOptions<T>): Promise<T> {
  const store = await cookieStore;
  const accessToken = token ?? store.get("pp_access")?.value;

  const url = new URL(`${API_BASE}${route}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url.toString(), init);
  } catch {
    throw new NetworkError();
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throwForStatus(response.status, errorBody as Record<string, unknown>);
  }

  const data = await response.json();
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) {
      throw new ApiContractError(route, e.message);
    }
    throw e;
  }
}
