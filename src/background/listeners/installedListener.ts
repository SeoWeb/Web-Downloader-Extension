import { initializeConnection } from "../connection";

export const installedListener = (details: chrome.runtime.InstalledDetails) => {
  // Initialize connection on install or update
  initializeConnection();

  console.log(details.reason)

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
