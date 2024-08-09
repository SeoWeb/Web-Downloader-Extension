declare global {
  interface Window {
    XMLHttpRequest: any;
    ActiveXObject: any;
  }
}

export async function smoothScrollToBottom() {
  const stepSize = 500;
  const waitDelay = 200;
  let lastScrollTop = getCurrentScrollTop();

  async function wait() {
    return new Promise<void>((resolve) => {
      setTimeout(() => resolve(), waitDelay);
    });
  }

  function getNextScrollTop() {
    return lastScrollTop + stepSize;
  }

  async function scrollTo() {
    const top = getNextScrollTop();
    window.scrollTo({
      top,
    });

    return await wait();
  }

  function getCurrentScrollTop() {
    return window.scrollY || document.documentElement.scrollTop;
  }

  async function scrollDown() {
    await scrollTo();

    return {
      success: true,
      top: getCurrentScrollTop(),
      height: document.documentElement.scrollHeight,
      html: document.documentElement.outerHTML,
    };
  }

  return await scrollDown();
}
