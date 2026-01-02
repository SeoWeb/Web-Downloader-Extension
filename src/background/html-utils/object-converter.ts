import { DOMParser } from "linkedom";
import { fetchUrl } from "../urlUtils";

export function convertObjectElementsToRelative(
  htmlString: string,
  tabUrl: string,
  path: string = "./",
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const objects = doc.querySelectorAll("object[type^='image/'][data]");

  for (const object of objects) {
    let data: string | null = object.getAttribute("data");
    if (!data) continue;
    data = data.split("?")[0];

    const u = new URL(data.startsWith("http") ? data : tabUrl);
    const baseUrl = u.origin + "/";

    if (!data) continue;
    else if (data.startsWith("/") || data.startsWith("#")) {
      // Already relative, skip
    } else if (data.startsWith(baseUrl)) {
      const url = new URL(data, baseUrl);
      data = url.pathname + url.search + url.hash;
    }

    if (data.split(".").length > 1) {
      data = path + "images/" + data.split("/").pop();
    }

    object.setAttribute("data", data);
  }

  return doc.documentElement.outerHTML;
}

export async function convertObjectElementsToBase64(
  htmlString: string,
  tabUrl: string,
) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, "text/html");
  const objects = doc.querySelectorAll("object[type^='image/'][data]");

  for (const object of objects) {
    let data: string | null = object.getAttribute("data");
    if (!data) continue;

    const u = new URL(data.startsWith("http") ? data : tabUrl);
    const baseUrl = u.origin + "/";
    const response = await fetchUrl(data, baseUrl);

    if (response) {
      const blob = await response.blob();
      const reader = new FileReader();
      reader.readAsDataURL(blob);

      data = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          data = reader.result as string;
          resolve(data);
        };
        reader.onerror = (error) => {
          reject(error);
        };
      });
    }

    object.setAttribute("data", data);
  }

  return doc.documentElement.outerHTML;
}
