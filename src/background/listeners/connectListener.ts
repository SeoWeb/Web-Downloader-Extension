import {
  handleNewConnection,
  handlePortSpecificInitialization,
  initializePortListeners,
} from "../ports/connectionLifecycle";

/**
 * Listener for new connections from Popup or Sidepanel.
 * Sets up the port, processes any queued messages, sends initial store updates,
 * and attaches message/disconnect listeners.
 * @param port The port object representing the connection.
 */
export const connectListener = async (port: chrome.runtime.Port) => {
  // Set the port reference and process any queued messages for this port type
  handleNewConnection(port);

  // Perform initialization specific to the port type (e.g., send initial store update)
  await handlePortSpecificInitialization(port);

  // Attach the generic message and disconnect listeners
  initializePortListeners(port);
};
