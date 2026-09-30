const syncListener = (changes: {
  [key: string]: chrome.storage.StorageChange;
}) => {};

const localListener = (changes: {
  [key: string]: chrome.storage.StorageChange;
}) => {};

export const storageListener = (
  changes: {
    [key: string]: chrome.storage.StorageChange;
  },
  areaName: chrome.storage.AreaName,
) => {
  switch (areaName) {
    case "sync":
      return syncListener(changes);
    case "local":
      return localListener(changes);
  }
};
