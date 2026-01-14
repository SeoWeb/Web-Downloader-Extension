/**
 * Checks if storage permission is granted
 */
export async function hasStoragePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ["storage"] });
  } catch {
    return false;
  }
}

/**
 * Requests storage permission from user
 */
export async function requestStoragePermission(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ permissions: ["storage"] });
  } catch {
    return false;
  }
}


