import { API_URLS } from '../common/apiConstants.js';

const USER_ID_KEY = 'webPageDownloader_userId';

export interface UserIdResponse {
  id: number;
}

/**
 * Creates a new user ID via API call
 */
async function createUserIdOnServer(): Promise<number | null> {
  try {
    const response = await fetch(API_URLS.CREATE_USER_ID, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error('Failed to create user ID on server:', response.statusText);
      return null;
    }

    const data: UserIdResponse = await response.json();
    return data.id;
  } catch (error) {
    console.error('Error creating user ID on server:', error);
    return null;
  }
}

/**
 * Checks if storage permission is granted
 */
export async function hasStoragePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['storage'] });
  } catch (error) {
    console.error('Error checking storage permission:', error);
    return false;
  }
}

/**
 * Requests storage permission from user
 */
export async function requestStoragePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ permissions: ['storage'] });
  } catch (error) {
    console.error('Error requesting storage permission:', error);
    return false;
  }
}

/**
 * Gets the user ID from Chrome storage, creates one if it doesn't exist
 */
export async function getUserId(): Promise<number | null> {
  try {
    // Check if we have storage permission
    const hasPermission = await hasStoragePermission();
    if (!hasPermission) {
      console.log('Storage permission not granted');
      return null;
    }

    // Try to get existing user ID from storage
    const result = await chrome.storage.local.get([USER_ID_KEY]);
    
    if (result[USER_ID_KEY]) {
      return result[USER_ID_KEY];
    }

    // Create new user ID on server
    const newUserId = await createUserIdOnServer();
    
    if (newUserId) {
      // Store the server-generated ID in Chrome storage
      await chrome.storage.local.set({ [USER_ID_KEY]: newUserId });
      console.log('New user ID generated and stored:', newUserId);
      return newUserId;
    } else {
      console.error('Failed to create user ID on server');
      return null;
    }
  } catch (error) {
    console.error('Error managing user ID:', error);
    return null;
  }
}

/**
 * Clears the stored user ID (for testing purposes)
 */
export async function clearUserId(): Promise<void> {
  try {
    await chrome.storage.local.remove([USER_ID_KEY]);
    console.log('User ID cleared from storage');
  } catch (error) {
    console.error('Error clearing user ID:', error);
  }
}

/**
 * Checks if user ID exists in storage
 */
export async function hasUserId(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get([USER_ID_KEY]);
    return !!result[USER_ID_KEY];
  } catch (error) {
    console.error('Error checking user ID:', error);
    return false;
  }
}