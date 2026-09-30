import { StateStorage } from 'zustand/middleware';

interface ExtendedStateStorage extends StateStorage {
  getItemValue: (name: string, fieldName: string) => Promise<any>;
  setPartialItem: (name: string, value: Record<string, unknown>) => unknown | Promise<void>;
}

// Custom storage object
export const chromeStorage: ExtendedStateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const result = await chrome.storage.local.get(name);
    return result[name] || null;
  },
  getItemValue: async (name, fieldName) => {
    const result = await chrome.storage.local.get(name);
    const data = JSON.parse(result[name] || "{}");
    const state = data.state || {};

    return state[fieldName] || null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    await chrome.storage.local.set({ [name]: value });
  },
  removeItem: async (name: string): Promise<void> => {
    await chrome.storage.local.remove(name);
  },
  setPartialItem: async (name: string, value: Record<string, unknown>): Promise<void> => {
    const result = await chrome.storage.local.get(name);
    const data = JSON.parse(result[name] || "{}");
    const state = data.state || {};
    const newValue = {
      ...data,
      state: {
        ...state,
        ...value
      }
    };
    await chrome.storage.local.set({ [name]: JSON.stringify(newValue) });
  }
};