/**
 * Auth types for PagePocket cloud storage integration.
 */

export interface PagePocketUser {
  id: string;
  email: string;
  name: string;
}

export interface PagePocketAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: PagePocketUser;
}

export const PAGEPOCKET_AUTH_STORAGE_KEY = "pagepocket_auth";
export const PAGEPOCKET_CLOUD_ENABLED_KEY = "pagepocket_cloud_enabled";
