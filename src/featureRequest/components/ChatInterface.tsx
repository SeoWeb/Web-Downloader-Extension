import React, { useState, useRef, useEffect } from 'react';
import { ConversationMessage } from './ConversationMessage';
import { ConversationManager } from '../utils/conversationManager';

interface ChatInterfaceProps {
  conversation: ConversationManager;
  onSendMessage: (message: string) => void;
  isLoading: boolean;
  onSwitchToManual: () => void;
}

export function ChatInterface({
  conversation,
  onSendMessage,
  isLoading,
  // onSwitchToManual
}: ChatInterfaceProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const messages = conversation.getMessages();

  // Auto-scroll to bottom when new messages arrive - only within the chat container
  useEffect(() => {
    if (messagesContainerRef.current && messagesEndRef.current) {
      const container = messagesContainerRef.current;
      const endElement = messagesEndRef.current;
      
      // Scroll within the container only, not the entire page
      container.scrollTo({
        top: endElement.offsetTop,
        behavior: 'smooth'
      });
    }
  }, [messages]);

  // Focus input when component mounts or loading stops
  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && !isLoading) {
      onSendMessage(inputValue.trim());
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border">
      {/* Magical Header */}
      <div className="border-b px-6 py-4">
        {/* Magical Header Section */}
        <div className="relative group mb-2">
          {/* Magical glow background */}
          <div className="absolute -inset-2 bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 rounded-lg blur opacity-15 group-hover:opacity-30 transition duration-1000 animate-pulse"></div>
          
          {/* Header content */}
          <div className="relative bg-gradient-to-r from-purple-50 via-pink-50 to-indigo-50 rounded-lg p-3 border border-purple-200">
            <div className="flex items-center justify-center space-x-3">
              <span className="text-2xl animate-bounce">🤖</span>
              <h2 className="text-xl font-bold bg-gradient-to-r from-purple-600 via-pink-600 to-indigo-600 bg-clip-text text-transparent">
                AI Assistant
              </h2>
              <span className="text-2xl animate-bounce" style={{ animationDelay: '0.5s' }}>✨</span>
            </div>
            
            {/* Floating sparkles */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
              <div className="absolute top-1 left-6 w-1 h-1 bg-purple-400 rounded-full animate-ping opacity-75"></div>
              <div className="absolute top-4 right-8 w-1 h-1 bg-pink-400 rounded-full animate-pulse opacity-75" style={{ animationDelay: '1s' }}></div>
              <div className="absolute bottom-1 left-12 w-1 h-1 bg-blue-400 rounded-full animate-bounce opacity-75" style={{ animationDelay: '1.5s' }}></div>
              <div className="absolute bottom-3 right-4 w-1 h-1 bg-yellow-400 rounded-full animate-ping opacity-75" style={{ animationDelay: '2s' }}></div>
            </div>
          </div>
        </div>
        
        <p className="text-sm text-purple-700 font-medium text-center">
          ✨ I'll help you structure your magical feature request ✨
        </p>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="px-6 py-4 max-h-96 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <div className="text-4xl mb-2">🤖</div>
            <p>Starting conversation...</p>
          </div>
        ) : (
          <>
            {messages.map((message, index) => {
              const isLatestAI = message.type === 'ai' && index === messages.length - 1;
              return (
                <ConversationMessage
                  key={message.id}
                  message={message}
                  onAnswerOptionClick={onSendMessage}
                  isLatestAI={isLatestAI}
                  isLoading={isLoading}
                />
              );
            })}
            {isLoading && (
              <div className="flex justify-start mb-4">
                <div className="max-w-[80%]">
                  <div className="bg-gray-100 text-gray-900 px-4 py-3 rounded-lg rounded-bl-sm">
                    <div className="flex items-center space-x-2">
                      <div className="flex space-x-1">
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                      </div>
                      <span className="text-sm text-gray-600">AI is thinking...</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t px-6 py-4">
        <form onSubmit={handleSubmit} className="flex space-x-3">
          <div className="flex-1">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type your response..."
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500 resize-none"
              rows={2}
              disabled={isLoading}
              maxLength={500}
            />
            <div className="text-xs text-gray-400 mt-1 text-right">
              {inputValue.length}/500
            </div>
          </div>
          <div className="flex flex-col justify-end">
            {/* Magical Send Button */}
            <div className="relative group">
              {/* Magical glow background */}
              <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 rounded-lg blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200 animate-pulse"></div>
              
              <button
                type="submit"
                disabled={!inputValue.trim() || isLoading}
                className={`
                  relative px-4 py-2 rounded-lg font-semibold text-white text-sm
                  bg-gradient-to-r from-purple-500 via-pink-500 to-indigo-500
                  hover:from-purple-600 hover:via-pink-600 hover:to-indigo-600
                  transform transition-all duration-300 ease-out
                  hover:scale-105 shadow-lg hover:shadow-xl
                  focus:outline-none focus:ring-4 focus:ring-purple-300 focus:ring-opacity-50
                  disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none
                  overflow-hidden
                `}
              >
                {/* Shimmer effect */}
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-0 hover:opacity-20 transform -skew-x-12 -translate-x-full hover:translate-x-full transition-transform duration-1000"></div>
                
                {/* Button content */}
                <div className="relative flex items-center justify-center space-x-2">
                  {isLoading ? (
                    <>
                      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-white"></div>
                      <span className="font-bold tracking-wide">Sending...</span>
                    </>
                  ) : (
                    <>
                      <span>Send</span>
                      <span className="text-sm">✨</span>
                    </>
                  )}
                </div>
              </button>
            </div>
          </div>
        </form>
        <div className="text-xs text-gray-500 mt-2">
          Press Enter to send, Shift+Enter for new line
        </div>
      </div>
    </div>
  );
}