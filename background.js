const {
  installedListener,
  startupListener,
  messageListener,
  sendMessage,
  storageListener,
  commandListener,
  contextMenuListener,
} = require("./src/background/functions");

// sendMessage({
//     action: "test",
//     data: "test"
// });

chrome.runtime.onInstalled.addListener(installedListener);

chrome.runtime.onStartup.addListener(startupListener);

chrome.runtime.onMessage.addListener(messageListener);

chrome.storage?.onChanged?.addListener(storageListener);

chrome.commands?.onCommand?.addListener(commandListener);

chrome.contextMenus?.onClicked?.addListener(contextMenuListener);
