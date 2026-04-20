import { DOMParser } from "linkedom";
import { convertLinksToRelative } from "./link-converter";
import {
  convertImagesToRelative,
  convertImagesToBase64,
} from "./image-converter";
import {
  convertBackgroundImagesToRelative,
  convertBackgroundImagesToBase64,
} from "./background-image-converter";
import {
  convertObjectElementsToRelative,
  convertObjectElementsToBase64,
} from "./object-converter";
import {
  convertStylesToRelative,
  convertStylesToBase64,
} from "./style-converter";
import {
  convertScriptsToRelative,
  convertScriptsToBase64,
} from "./script-converter";

export function convertHtml(
  inputHtml: string,
  tabUrl: string,
  path: string = "./",
  imageFilenameMap?: Map<string, string>,
) {
  let html = convertLinksToRelative(inputHtml, tabUrl, path);

  if (html.includes("<base")) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const base = doc.querySelector("base");
    if (base) {
      base.remove();
      html = doc.documentElement.outerHTML;
    }
  }

  html = convertImagesToRelative(html, tabUrl, path, imageFilenameMap);
  html = convertBackgroundImagesToRelative(html, tabUrl, path);
  html = convertObjectElementsToRelative(html, tabUrl, path);
  html = convertStylesToRelative(html, tabUrl, path);
  html = convertScriptsToRelative(html, tabUrl, path);

  return html;
}

export async function convertToSingleFileHtml(
  inputHtml: string,
  tabUrl: string,
) {
  let html = inputHtml;

  if (html.includes("<base")) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const base = doc.querySelector("base");
    if (base) {
      base.remove();
      html = doc.documentElement.outerHTML;
    }
  }

  html = await convertImagesToBase64(html, tabUrl);
  html = await convertBackgroundImagesToBase64(html, tabUrl);
  html = await convertObjectElementsToBase64(html, tabUrl);
  html = await convertStylesToBase64(html, tabUrl);
  html = await convertScriptsToBase64(html, tabUrl);

  return html;
}
