import { useEffect, useRef } from "react";

type KeyHandler = (e: KeyboardEvent) => void;

type HotkeyBinding = {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  handler: KeyHandler;
};

export function useHotkeys(bindings: HotkeyBinding[]) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Ignore when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      for (const binding of bindingsRef.current) {
        const ctrlMatch = binding.ctrl ? (e.ctrlKey || e.metaKey) : !e.ctrlKey && !e.metaKey;
        const metaMatch = binding.meta ? e.metaKey : true;
        if (e.key === binding.key && ctrlMatch && metaMatch) {
          binding.handler(e);
          return;
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
