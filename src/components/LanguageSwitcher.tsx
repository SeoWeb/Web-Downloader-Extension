import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { languages, getLanguageByCode } from "../i18n/languages";
import { ChevronDown, Search, Globe } from "lucide-react";

export const LanguageSwitcher: React.FC = () => {
  const { i18n, t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Type-ahead buffer: keystrokes accumulate briefly to match multi-char prefixes
  const typeAheadRef = useRef<{ query: string; timestamp: number }>({
    query: "",
    timestamp: 0,
  });

  const currentLanguage = getLanguageByCode(i18n.language) || languages[0];

  // Filter languages based on search query
  const filteredLanguages = languages.filter(
    (lang) =>
      lang.nativeName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lang.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lang.code.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const handleLanguageChange = (languageCode: string) => {
    i18n.changeLanguage(languageCode);
    setIsOpen(false);
    setSearchQuery("");
  };

  const closeDropdown = () => {
    setIsOpen(false);
    setSearchQuery("");
    // Return focus to the trigger so keyboard users keep their place.
    triggerRef.current?.focus();
  };

  /** Move focus between the rendered `role="option"` buttons. */
  const moveOptionFocus = (direction: 1 | -1) => {
    const options = Array.from(
      dropdownRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? [],
    );
    if (options.length === 0) return;
    const currentIndex = options.findIndex(
      (option) => option === document.activeElement,
    );
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : options.length - 1
        : (currentIndex + direction + options.length) % options.length;
    options[nextIndex]?.focus();
  };

  /** Type-ahead: jump to the next option matching the buffered query. */
  const handleTypeAhead = (char: string, target: HTMLElement) => {
    const now = Date.now();
    const buffer =
      now - typeAheadRef.current.timestamp > 500
        ? ""
        : typeAheadRef.current.query;
    const query = (buffer + char).toLowerCase();
    typeAheadRef.current = { query, timestamp: now };

    const options = Array.from(
      dropdownRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]',
      ) ?? [],
    );
    if (options.length === 0) return;
    const startIndex = Math.max(
      options.findIndex((option) => option === target),
      0,
    );
    for (let step = 1; step <= options.length; step++) {
      const option = options[(startIndex + step) % options.length];
      const text = option.textContent?.toLowerCase() ?? "";
      if (text.includes(query)) {
        option.focus();
        return;
      }
    }
  };

  /**
   * (5.6) Listbox keyboard support: ArrowUp/ArrowDown move between options,
   * Escape closes, printable keys type-ahead. Handles events bubbling from
   * both the search input and the option buttons.
   */
  const handleDropdownKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDropdown();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveOptionFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // Type-ahead only when the event originates from an option button —
    // the search input already filters as the user types.
    const target = event.target as HTMLElement;
    if (
      target?.getAttribute?.("role") === "option" &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      handleTypeAhead(event.key.toLowerCase(), target);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent, languageCode: string) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      handleLanguageChange(languageCode);
    }
  };

  const isRTL = i18n.dir() === "rtl";

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        ref={triggerRef}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors"
        aria-label={t("language.select")}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
      >
        <Globe className="w-4 h-4" />
        <span className="hidden sm:inline">{currentLanguage.nativeName}</span>
        <span className="sm:hidden">{currentLanguage.code.toUpperCase()}</span>
        <ChevronDown
          className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen && (
        <div
          className="absolute top-full mt-2 w-72 bg-white border border-gray-300 rounded-lg shadow-lg z-50 max-h-96 overflow-hidden flex !flex-col"
          style={{ insetInlineEnd: 0 }}
          onKeyDown={handleDropdownKeyDown}
        >
          {/* Search input */}
          <div className="p-3 border-b border-gray-200">
            <div className="relative">
              <Search
                className={`absolute top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 ${isRTL ? "right-3" : "left-3"}`}
              />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t("language.search")}
                className={`w-full py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 ${isRTL ? "pr-10" : "pl-10 pr-3"}`}
                style={isRTL ? { paddingLeft: "0.75rem" } : undefined}
                aria-label={t("language.search")}
                dir={isRTL ? "rtl" : "ltr"}
              />
            </div>
          </div>

          {/* Language list */}
          <div className="overflow-y-auto flex-1" role="listbox">
            {filteredLanguages.length > 0 ? (
              filteredLanguages.map((lang) => (
                <button
                  key={lang.code}
                  onClick={() => handleLanguageChange(lang.code)}
                  onKeyDown={(e) => handleKeyDown(e, lang.code)}
                  className={`w-full px-4 py-2.5 text-sm hover:bg-gray-100 focus:bg-gray-100 focus:outline-none transition-colors ${
                    isRTL ? "text-right" : "text-left"
                  } ${
                    lang.code === i18n.language
                      ? "bg-blue-50 text-blue-700 font-medium"
                      : "text-gray-700"
                  }`}
                  role="option"
                  aria-selected={lang.code === i18n.language}
                  dir={isRTL ? "rtl" : "ltr"}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{lang.nativeName}</div>
                      <div className="text-xs text-gray-500">{lang.name}</div>
                    </div>
                    {lang.code === i18n.language && (
                      <svg
                        className="w-5 h-5 text-blue-600"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </div>
                </button>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-gray-500">
                {t("language.noMatches")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
