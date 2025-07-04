import { useState } from 'react';

export function FeatureRequestButton() {
  const [isHovered, setIsHovered] = useState(false);
  const [isClicked, setIsClicked] = useState(false);

  const openFeatureRequestPage = () => {
    setIsClicked(true);
    setTimeout(() => setIsClicked(false), 200);
    chrome.tabs.create({
      url: chrome.runtime.getURL('featureRequest.html')
    });
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-200">
      <div className="relative group">
        {/* Magical glow background */}
        <div className="absolute -inset-1 bg-gradient-to-r from-purple-600 via-pink-600 to-blue-600 rounded-lg blur opacity-25 group-hover:opacity-75 transition duration-1000 group-hover:duration-200 animate-pulse"></div>
        
        {/* Main button */}
        <button
          onClick={openFeatureRequestPage}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className={`
            relative w-full px-6 py-4 rounded-lg font-semibold text-white
            bg-gradient-to-r from-purple-500 via-pink-500 to-indigo-500
            hover:from-purple-600 hover:via-pink-600 hover:to-indigo-600
            transform transition-all duration-300 ease-out
            ${isHovered ? 'scale-105 shadow-2xl' : 'scale-100 shadow-lg'}
            ${isClicked ? 'scale-95' : ''}
            focus:outline-none focus:ring-4 focus:ring-purple-300 focus:ring-opacity-50
            overflow-hidden
          `}
        >
          {/* Shimmer effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white to-transparent opacity-0 hover:opacity-20 transform -skew-x-12 -translate-x-full hover:translate-x-full transition-transform duration-1000"></div>
          
          {/* Sparkle particles */}
          <div className="absolute inset-0 overflow-hidden">
            <div className={`absolute top-2 left-4 w-1 h-1 bg-white rounded-full animate-ping ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity duration-300`}></div>
            <div className={`absolute top-6 right-6 w-1 h-1 bg-yellow-300 rounded-full animate-pulse ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity duration-500 delay-100`}></div>
            <div className={`absolute bottom-3 left-8 w-1 h-1 bg-pink-300 rounded-full animate-bounce ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity duration-700 delay-200`}></div>
            <div className={`absolute bottom-6 right-4 w-1 h-1 bg-blue-300 rounded-full animate-ping ${isHovered ? 'opacity-100' : 'opacity-0'} transition-opacity duration-400 delay-300`}></div>
          </div>
          
          {/* Button content */}
          <div className="relative flex items-center justify-center space-x-3">
            <span className={`text-2xl transform transition-transform duration-300 ${isHovered ? 'rotate-12 scale-110' : ''}`}>
              ✨
            </span>
            <span className="text-lg font-bold tracking-wide">
              Make a Wish
            </span>
            <span className={`text-2xl transform transition-transform duration-300 ${isHovered ? '-rotate-12 scale-110' : ''}`}>
              🌟
            </span>
          </div>
          
          {/* Magic wand trail effect */}
          {/* <div className={`absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-0 h-0 ${isClicked ? 'animate-ping' : ''}`}>
            <div className="w-8 h-8 bg-yellow-300 rounded-full opacity-75"></div>
          </div> */}
        </button>
        
        {/* Floating magical text */}
        {/* <div className={`absolute bottom-8 left-1/2 transform -translate-x-1/2 text-xs text-purple-600 font-medium transition-all duration-300 ${isHovered ? 'opacity-100 -translate-y-2' : 'opacity-0 translate-y-0'}`}>
          ✨ Your wishes come true ✨
        </div> */}
      </div>
    </div>
  );
}