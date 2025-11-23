/**
 * Checks if storage permission is granted
 */
export async function hasStoragePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["storage"] });
  } catch (error) {
    console.error("Error checking storage permission:", error);
    return false;
  }
}

/**
 * Requests storage permission from user
 */
export async function requestStoragePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ permissions: ["storage"] });
  } catch (error) {
    console.error("Error requesting storage permission:", error);
    return false;
  }
}

/**
 * Checks if offscreen permission is granted
 */
export async function hasOffscreenPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["offscreen"] });
  } catch (error) {
    console.error("Error checking offscreen permission:", error);
    return false;
  }
}

/**
 * Requests offscreen permission from user
 */
export async function requestOffscreenPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ permissions: ["offscreen"] });
  } catch (error) {
    console.error("Error requesting offscreen permission:", error);
    return false;
  }
}
