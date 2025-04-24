import { io, Socket } from 'socket.io-client';
import { API_URL } from '../config/constants';
import { chromeStorage } from "../common/chrome/storage";

let socket: Socket | null = null;

interface ConnectResponse {
  success: boolean;
  message: string;
  connection_id?: number; // Make optional in case of failure
}

export const initializeConnection = async (): Promise<void> => {
  try {
    if (socket?.connected) {
      return;
    }

    let connectionId = await chromeStorage.getItemValue("user-data-storage", "connection_id");

    if (!connectionId) {
      const response = await fetch(`${API_URL}/api/connect`);
      if (!response.ok) {
        throw new Error(`API request failed with status: ${response.status}`);
      }

      const data: ConnectResponse = await response.json();
      console.log('API Connect Response:', data);

      if (data.success && data.connection_id) {
        connectionId = data.connection_id;
      }
    }

    if (connectionId) {
      console.log(`Successfully connected, connection ID: ${connectionId}`);

      if (socket?.connected) {
        console.log('Disconnecting previous socket connection...');
        socket.disconnect();
      }

      console.log('Establishing socket connection...');
      socket = io(API_URL, {
        transports: ['websocket'], // Force websocket transport
      });

      socket.on('connect', () => {
        console.log('Socket connected successfully. Identifying...');
        socket?.emit('identify', { connectionId });
      });

      socket.on('identify_status', (status: { success: boolean; message: string }) => {
        chromeStorage.setPartialItem("user-data-storage", {
          connection_id: connectionId
        });
        console.log('Socket Identify Status:', status);
        if (!status.success) {
          console.error('Socket identification failed:', status.message);
        } else {
            console.log('Socket identified successfully.');
        }
      });

      socket.on('disconnect', (reason: string) => {
        console.log('Socket disconnected:', reason);
        socket = null; // Clear socket reference
      });

      socket.on('connect_error', (error: Error) => {
        console.error('Socket connection error:', error);
        socket = null; // Clear socket reference
      });

    } else {
      console.error('API connection failed: connection id not found');
    }
  } catch (error) {
    console.error('Error initializing connection:', error);
  }
};

export const getSocket = (): Socket | null => {
    return socket;
}