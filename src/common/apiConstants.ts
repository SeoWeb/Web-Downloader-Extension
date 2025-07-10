/**
 * API Constants for n8n.webuilder.dev endpoints
 * Centralized configuration for all API endpoints used in the application
 */

// Base API URL
export const API_BASE_URL = 'https://n8n.webuilder.dev/webhook';

// API Endpoint IDs
export const API_ENDPOINTS = {
  // User management
  CREATE_USER_ID: '40fa49f0-df07-431b-915d-f04a87e55996',
  
  // Feature requests
  SUBMIT_FEATURE_REQUEST: '71a655f2-7498-4553-9678-46c49b4fd5e8',
  GET_FEATURE_REQUESTS: '0bd715f9-d441-4cdd-be43-d5b9e031203a',
  
  // Voting
  VOTE_FEATURE: '390fb873-464f-4293-9ae9-3517799412e6',
  
  // AI analysis
  AI_FEATURE_ANALYSIS: 'c713c0fb-a7e7-4693-b954-180ce35cf416',

  ANALYTICS: 'ee46e968-d6f8-49b8-8705-c222f0ab63d8'
} as const;

// Full URL builders for convenience
export const API_URLS = {
  CREATE_USER_ID: `${API_BASE_URL}/${API_ENDPOINTS.CREATE_USER_ID}`,
  SUBMIT_FEATURE_REQUEST: `${API_BASE_URL}/${API_ENDPOINTS.SUBMIT_FEATURE_REQUEST}`,
  GET_FEATURE_REQUESTS: `${API_BASE_URL}/${API_ENDPOINTS.GET_FEATURE_REQUESTS}`,
  VOTE_FEATURE: `${API_BASE_URL}/${API_ENDPOINTS.VOTE_FEATURE}`,
  AI_FEATURE_ANALYSIS: `${API_BASE_URL}/${API_ENDPOINTS.AI_FEATURE_ANALYSIS}`,
  ANALYTICS: `${API_BASE_URL}/${API_ENDPOINTS.ANALYTICS}`,
} as const;

// Type definitions for endpoint keys
export type ApiEndpoint = keyof typeof API_ENDPOINTS;
export type ApiUrl = keyof typeof API_URLS;