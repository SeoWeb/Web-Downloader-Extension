import { io, Socket } from 'socket.io-client';
import { API_URL } from '../config/constants';

let socket: Socket | null = null;

interface ConnectResponse {
  success: boolean;
  message: string;
  connection_id?: number; // Make optional in case of failure
}

export const initializeConnection = async (): Promise<void> => {
  console.log('Attempting to initialize connection...');
  try {
    const response = await fetch(`${API_URL}/api/connect`);
    if (!response.ok) {
      throw new Error(`API request failed with status: ${response.status}`);
    }

    const data: ConnectResponse = await response.json();
    console.log('API Connect Response:', data);

    if (data.success && data.connection_id) {
      const connectionId = data.connection_id;
      console.log(`Successfully connected to API, connection ID: ${connectionId}`);

      // Disconnect previous socket if exists
      if (socket?.connected) {
        console.log('Disconnecting previous socket connection...');
        socket.disconnect();
      }

      console.log('Establishing socket connection...');
      socket = io(API_URL, {
        // Optional: Add any necessary socket options here
        transports: ['websocket'], // Force websocket transport
      });

      socket.on('connect', () => {
        console.log('Socket connected successfully. Identifying...');
        socket?.emit('identify', { connectionId });
      });

      socket.on('identify_status', (status: { success: boolean; message: string }) => {
        console.log('Socket Identify Status:', status);
        if (!status.success) {
          console.error('Socket identification failed:', status.message);
          // Optional: Handle identification failure (e.g., retry, notify user)
        } else {
            console.log('Socket identified successfully.');
        }
      });

      socket.on('disconnect', (reason: string) => {
        console.log('Socket disconnected:', reason);
        socket = null; // Clear socket reference
        // Optional: Implement reconnection logic if needed
      });

      socket.on('connect_error', (error: Error) => {
        console.error('Socket connection error:', error);
        socket = null; // Clear socket reference
        // Optional: Handle connection error
      });

    } else {
      console.error('API connection failed:', data.message);
      // Optional: Handle API connection failure
    }
  } catch (error) {
    console.error('Error initializing connection:', error);
    // Optional: Handle fetch or other errors
  }
};

// Optional: Function to get the current socket instance if needed elsewhere
export const getSocket = (): Socket | null => {
    return socket;
}