import React from 'react';
import { Sun, Moon } from 'lucide-react';

export const ThemeToggle = ({ isDarkMode, setIsDarkMode }: { isDarkMode: boolean; setIsDarkMode: (val: boolean) => void }) => {
  return (
    /* Exact positioning wrapper from this project */
    <div className="absolute top-3 left-4 lg:top-6 sm:left-8 z-50">
      <button 
        onClick={() => setIsDarkMode(!isDarkMode)}
        className="p-2 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg hover:opacity-80 transition-all text-[var(--text-primary)] shadow-sm cursor-pointer"
        title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
      >
        {isDarkMode ? (
          <Sun size={18} fill="white" fillOpacity={0.5} />
        ) : (
          <Moon size={18} fill="white" fillOpacity={0.5} />
        )}
      </button>
    </div>
  );
};
