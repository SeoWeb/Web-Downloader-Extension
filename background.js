import { listenMessage } from "./src/common/chrome";
import { messageWorker } from "./src/background/message";

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.setOptions(
    { tabId: tab.id, path: "sidePanel.html", enabled: true },
    () => {
      chrome.sidePanel.open({ tabId: tab.id });
    },
  );
});

listenMessage(async (message, addMessage) => {
  const action = message.action;
  const data = message.data;
  return await messageWorker(action, data, addMessage);
}, "background");
