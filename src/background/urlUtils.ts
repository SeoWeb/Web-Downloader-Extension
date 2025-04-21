export async function fetchUrl(url: string, baseUrl: string, retries = 3, delay = 1000) {
  if (!url) return null;

  const fullUrl = new URL(url, baseUrl).href;
  
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(fullUrl);
      if (response.status >= 400) {
        if (i === retries - 1) return null;
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      return response;
    } catch (e) {
      if (i === retries - 1) {
        console.error(`Failed to fetch ${url} after ${retries} attempts`);
        return null;
      }
      await new Promise(res => setTimeout(res, delay));
    }
  }
  return null;
}

export function fixFilename(filename: string) {
  const newFilename = filename.split("?")[0];
  const extension = newFilename.split(".").pop();
  const name = newFilename
    .split(".")
    .slice(0, -1)
    .join(".")
    .replace(/[\/\\:*?"<>|&$@!%#^+={}\[\]~]/g, "")
    .slice(0, 200);

  return `${name}.${extension}`;
}