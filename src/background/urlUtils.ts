export async function fetchUrl(url: string, baseUrl: string, retries = 3, delay = 1000) {
  if (!url) return null;

  const fullUrl = new URL(url, baseUrl).href;
  
  for (let i = 0; i < retries; i++) {
    try {
      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
      
      const response = await fetch(fullUrl, {
        signal: controller.signal,
        // Add headers to prevent some blocking issues
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      });
      
      clearTimeout(timeoutId);
      
      if (response.status >= 400) {
        console.warn(`HTTP ${response.status} for ${fullUrl}`);
        if (i === retries - 1) return null;
        await new Promise(res => setTimeout(res, delay * (i + 1))); // Exponential backoff
        continue;
      }
      
      // Check if response is actually valid
      if (!response.body) {
        console.warn(`Empty response body for ${fullUrl}`);
        if (i === retries - 1) return null;
        await new Promise(res => setTimeout(res, delay * (i + 1)));
        continue;
      }
      
      return response;
    } catch (e) {
      console.warn(`Attempt ${i + 1} failed for ${fullUrl}:`, e);
      
      // Try alternative approach using chrome.tabs for external resources
      if (i < retries - 1) {
        try {
          console.log(`Trying alternative fetch method for ${fullUrl}`);
          const response = await fetch(fullUrl, {
            method: 'GET',
            mode: 'cors',
            cache: 'force-cache'
          });
          return response;
        } catch (fallbackError) {
          console.warn(`Alternative fetch method also failed for ${fullUrl}:`, fallbackError);
        }
      }
      
      if (i === retries - 1) {
        console.error(`Failed to fetch ${url} after ${retries} attempts`);
        return null;
      }
      await new Promise(res => setTimeout(res, delay * (i + 1))); // Exponential backoff
    }
  }
  return null;
}

export function fixFilename(filename: string) {
  if (!filename || typeof filename !== 'string') {
    return 'unknown_file';
  }
  
  // Remove query parameters and fragments
  const newFilename = filename.split(/[?#]/)[0];
  
  // Extract extension
  const extension = newFilename.split(".").pop();
  
  // Get the name without extension
  const nameParts = newFilename.split(".");
  const name = nameParts.slice(0, -1).join(".");
  
  // Clean the name
  const cleanName = name
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "-") // Replace invalid chars with hyphen
    .replace(/-+/g, "-") // Replace multiple hyphens with single
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .slice(0, 100) // Limit length
    || "file"; // Default name if empty
  
  // Ensure we have a valid extension
  const cleanExtension = extension && extension.length > 0 && extension.length <= 10
    ? extension.toLowerCase()
    : "bin";
  
  return `${cleanName}.${cleanExtension}`;
}