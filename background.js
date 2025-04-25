import {
  actionClickedListener,
  installedListener,
  startupListener,
  storageListener,
  commandListener,
  contextMenuListener,
  connectListener,
} from "./src/background/functions";

chrome.runtime.onConnect.addListener(connectListener);

chrome.action.onClicked.addListener(actionClickedListener);

chrome.runtime.onInstalled.addListener(installedListener);

chrome.runtime.onStartup.addListener(startupListener);

chrome.storage?.onChanged?.addListener(storageListener);

chrome.commands?.onCommand?.addListener(commandListener);

chrome.contextMenus?.onClicked?.addListener(contextMenuListener);
