import "server-only";
import type { cookies } from "next/headers";
import type { ZodType } from "zod";
import { ZodError } from "zod";
import { fetch as nativeFetch, type RequestInit as UndiciRequestInit } from "undici";
import { ApiContractError, NetworkError, throwForStatus } from "./errors";
import { API_GATEWAY_URL } from "@/lib/env";

const API_BASE = API_GATEWAY_URL;

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
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let response: Awaited<ReturnType<typeof nativeFetch>>;
  try {
    // Use undici's native fetch directly (not Next's patched global fetch) to
    // avoid the Turbopack fetch-cache adapter ("adapterFn is not a function")
    // that crashes inside Server Component renders in Next 16.2.x.
    response = await nativeFetch(url.toString(), init as UndiciRequestInit);
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
