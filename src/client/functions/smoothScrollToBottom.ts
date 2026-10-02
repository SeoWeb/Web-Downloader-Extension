export interface Response {
  html: string;
  scrollTop: number;
  scrollHeight: number;
}

export function smoothScrollToBottom(): Promise<Response> {
  return new Promise<Response>((resolve) => {
    let scrollTimeout: number | null = null;

    const scrollListener = () => {
      if (scrollTimeout !== null) {
        clearTimeout(scrollTimeout);
      }

      scrollTimeout = window.setTimeout(() => {
        // Scrolling likely finished
        window.removeEventListener("scroll", scrollListener);
        resolve({
          html: document.documentElement.outerHTML,
          scrollTop: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
        });
      }, 100); // Wait for 150ms of scroll inactivity
    };

    // Check if we are already at the bottom
    const initialScrollTop = window.scrollY;
    const maxScrollTop =
      document.documentElement.scrollHeight - window.innerHeight;

    if (initialScrollTop >= maxScrollTop) {
      // Already at the bottom, resolve immediately
      resolve({
        html: document.documentElement.outerHTML,
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
      });
      return;
    }

    window.addEventListener("scroll", scrollListener);

    // Initiate the scroll
    window.scrollBy({
      top: 800,
      left: 0,
      behavior: "smooth",
    });

    // Initial timeout in case scroll doesn't trigger (e.g., already at bottom after scrollBy call)
    // This also handles cases where the scroll amount is too small to trigger multiple events.
    scrollTimeout = window.setTimeout(() => {
      window.removeEventListener("scroll", scrollListener);
      resolve({
        html: document.documentElement.outerHTML,
        scrollTop: window.scrollY,
        scrollHeight: document.documentElement.scrollHeight,
      });
    }, 250); // A slightly longer timeout for the initial check
  });
}
