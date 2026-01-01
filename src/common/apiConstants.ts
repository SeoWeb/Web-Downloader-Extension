/**
 * API Constants for n8n.webuilder.dev endpoints
 * Centralized configuration for all API endpoints used in the application
 */

// Base API URL
export const API_BASE_URL = "https://n8n.webuilder.dev/webhook";

// API Endpoint IDs
export const API_ENDPOINTS = {
  // User management
  CREATE_USER_ID: "40fa49f0-df07-431b-915d-f04a87e55996",

  // AI analysis
  // AI_FEATURE_ANALYSIS: "c713c0fb-a7e7-4693-b954-180ce35cf416",

  ANALYTICS: "ee46e968-d6f8-49b8-8705-c222f0ab63d8",
} as const;

// Full URL builders for convenience
export const API_URLS = {
  CREATE_USER_ID: `${API_BASE_URL}/${API_ENDPOINTS.CREATE_USER_ID}`,
  ANALYTICS: `${API_BASE_URL}/${API_ENDPOINTS.ANALYTICS}`,
} as const;

// Type definitions for endpoint keys
export type ApiEndpoint = keyof typeof API_ENDPOINTS;
export type ApiUrl = keyof typeof API_URLS;
