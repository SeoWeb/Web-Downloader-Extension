import { Message } from "../../types/message";

let popupPort: chrome.runtime.Port | null = null;
let sidePanelPort: chrome.runtime.Port | null = null;
let popupMessageQueue: Message[] = [];
let sidePanelMessageQueue: Message[] = [];

export const getPopupPort = () => popupPort;
export const setPopupPort = (port: chrome.runtime.Port | null) => {
  popupPort = port;
};

export const getSidePanelPort = () => sidePanelPort;
export const setSidePanelPort = (port: chrome.runtime.Port | null) => {
  sidePanelPort = port;
};

export const getPopupMessageQueue = () => popupMessageQueue;
export const shiftPopupMessageQueue = () => popupMessageQueue.shift();
export const pushPopupMessageQueue = (message: Message) => popupMessageQueue.push(message);

export const getSidePanelMessageQueue = () => sidePanelMessageQueue;
export const shiftSidePanelMessageQueue = () => sidePanelMessageQueue.shift();
export const pushSidePanelMessageQueue = (message: Message) => sidePanelMessageQueue.push(message);

export const clearPopupPort = () => {
    popupPort = null;
}

export const clearSidePanelPort = () => {
    sidePanelPort = null;
}