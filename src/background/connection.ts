import { io, Socket } from "socket.io-client";
import { API_URL, SOCKET_URL } from "../config/constants";
import { chromeStorage } from "../common/chrome/storage";

interface ConnectResponse {
  success: boolean;
  message: string;
  connection_id?: number; // Make optional in case of failure
}

async function getConnectionId() {
  let connectionId = await chromeStorage.getItemValue(
    "user-data-storage",
    "connection_id",
  );
  if (!connectionId) {
    const response = await fetch(`${API_URL}/api/connect`);
    if (!response.ok) {
      return null;
    }

    const data: ConnectResponse = await response.json();
    if (data.success && data.connection_id) {
      connectionId = data.connection_id;
    }
  }
  return connectionId;
}

async function onConnect(
  socket: Socket,
  connectionId: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    socket.on("connect", () => {
      socket?.emit(
        "identify",
        { connectionId },
        (response: { success: boolean; message: string }) => {
          if (response?.success) {
            console.log("identified");
            chromeStorage.setPartialItem("user-data-storage", {
              connection_id: connectionId,
            });
            resolve(true);
          } else {
            console.warn("Socket identification failed:", response.message);
            resolve(false);
          }
        },
      );
    });
  });
}

const initializeConnection = async (): Promise<Socket | null> => {
  chromeStorage.setPartialItem("user-data-storage", {
    connection_id: null,
  });
  try {
    const connectionId = await getConnectionId();
    if (connectionId) {
      const socket = io(SOCKET_URL, {
        transports: ["websocket"], // Force websocket transport
      });

      if (await onConnect(socket, connectionId)) {
        return socket;
      }
    } else {
      console.warn("API connection failed: connection id not found");
    }
  } catch (error) {
    console.warn("Error initializing connection:", error);
  }

  return null;
};

let socket: Socket | null = null;

export const getSocket = async (): Promise<Socket | null> => {
  if (!socket) {
    socket = await initializeConnection();
  }
  return socket;
};

export const closeSocketConnection = async () => {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
