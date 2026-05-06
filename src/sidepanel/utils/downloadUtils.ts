export function mergeDownloadResponse(_prev: any, response: any) {
  // In server-only mode, response.html contains the latest full page state.
  // The server handles final HTML assembly during download finalization.
  const html = response.html || "";

  return {
    html,
    top: response.top,
    height: response.height,
  };
}
