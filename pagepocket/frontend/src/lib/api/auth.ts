import { cookies } from "next/headers";
import { serverFetch } from "./http";
import { AuthResponseSchema } from "./schemas";

export const auth = {
  async login(email: string, password: string) {
    return serverFetch({
      route: "/auth/login",
      method: "POST",
      body: { email, password },
      schema: AuthResponseSchema,
      cookieStore: await cookies(),
      token: "",
    });
  },

  async register(email: string, password: string, name: string) {
    return serverFetch({
      route: "/auth/register",
      method: "POST",
      body: { email, password, name },
      schema: AuthResponseSchema,
      cookieStore: await cookies(),
      token: "",
    });
  },

  async refresh(refreshToken: string) {
    return serverFetch({
      route: "/auth/refresh",
      method: "POST",
      body: { refresh_token: refreshToken },
      schema: AuthResponseSchema,
      cookieStore: await cookies(),
      token: "",
    });
  },

  async logout() {
    return serverFetch({
      route: "/auth/logout",
      method: "POST",
      schema: AuthResponseSchema,
      cookieStore: await cookies(),
      token: "",
    });
  },
};
