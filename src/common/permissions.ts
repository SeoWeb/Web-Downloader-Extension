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


