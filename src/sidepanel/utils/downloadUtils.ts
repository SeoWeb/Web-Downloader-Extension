import { mergeHtml } from "../../background/merge-html";

export function mergeDownloadResponse(prev: any, response: any) {
  let html = "";

  if (!!prev?.html?.length && prev.height !== response.height) {
    html = mergeHtml(prev.html, response.html);
  } else {
    html = response.html;
  }

  return {
    html,
    top: response.top,
    height: response.height,
  };
}
