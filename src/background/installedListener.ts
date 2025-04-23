export const installedListener = (details: chrome.runtime.InstalledDetails) => {
  switch (details.reason) {
    case "install":
      break;
    case "update":
      if (details.previousVersion && details.previousVersion < chrome.runtime.getManifest().version) {
        // TODO:
      }
      break;
    case "chrome_update":
      break;
    case "shared_module_update":
      break;
  }
};
