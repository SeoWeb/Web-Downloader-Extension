import {
  installedListener,
  startupListener,
  messageListener,
  storageListener,
  commandListener,
  contextMenuListener,
} from "./src/background/functions";

// sendMessage({
//     action: "test",
//     data: "test"
// });

chrome.runtime.onInstalled.addListener(installedListener);

chrome.runtime.onStartup.addListener(startupListener);

messageListener('backend');

chrome.storage?.onChanged?.addListener(storageListener);

chrome.commands?.onCommand?.addListener(commandListener);

chrome.contextMenus?.onClicked?.addListener(contextMenuListener);
