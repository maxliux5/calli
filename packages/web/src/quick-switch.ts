import { useEffect, useState } from 'react';

/** Where the phone's quick-switch control sits, and which form this device shows (off by default). */
export type QuickSwitchMode = 'off' | 'handle' | 'button';

export const QUICK_SWITCH_HIDDEN_KEY = 'calli.quickSwitch.hidden';
export const QUICK_SWITCH_MODE_KEY = 'calli.quickSwitch.mode';
const QUICK_SWITCH_EVENT = 'calli:quick-switch-mode';
const QUICK_SWITCH_BOTTOM_KEY = 'calli.quickSwitch.bottom';
const QUICK_SWITCH_BOTTOM = 200;

/** Reads the current quick-switch mode from localStorage; defaults to `off` when unset. */
export function readQuickSwitchMode(): QuickSwitchMode {
  try {
    if (localStorage.getItem(QUICK_SWITCH_HIDDEN_KEY) === '1') return 'off';
    const mode = localStorage.getItem(QUICK_SWITCH_MODE_KEY);
    if (mode === 'off' || mode === 'handle' || mode === 'button') return mode;
    if (localStorage.getItem(QUICK_SWITCH_HIDDEN_KEY) === '0') return 'handle';
    return 'off';
  } catch {
    return 'off';
  }
}

export function saveQuickSwitchMode(mode: QuickSwitchMode): void {
  try {
    localStorage.setItem(QUICK_SWITCH_MODE_KEY, mode);
    localStorage.setItem(QUICK_SWITCH_HIDDEN_KEY, mode === 'off' ? '1' : '0');
  } catch {
    // lasts until reload
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(QUICK_SWITCH_EVENT));
}

export function useQuickSwitchMode(): [QuickSwitchMode, (mode: QuickSwitchMode) => void] {
  const [mode, setMode] = useState<QuickSwitchMode>(readQuickSwitchMode);
  useEffect(() => {
    const sync = () => setMode(readQuickSwitchMode());
    window.addEventListener(QUICK_SWITCH_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(QUICK_SWITCH_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return [mode, (next: QuickSwitchMode) => { setMode(next); saveQuickSwitchMode(next); }];
}

/** Keep the handle on screen, clear of the input area below and the top bar above. */
export const clampQuickSwitchBottom = (value: number) =>
  Math.round(Math.min(Math.max(value, 120), Math.max(120, window.innerHeight - 140)));
export const savedQuickSwitchBottom = () => {
  try {
    const saved = Number(localStorage.getItem(QUICK_SWITCH_BOTTOM_KEY));
    return clampQuickSwitchBottom(Number.isFinite(saved) && saved > 0 ? saved : QUICK_SWITCH_BOTTOM);
  } catch {
    return QUICK_SWITCH_BOTTOM;
  }
};
export const saveQuickSwitchBottom = (value: number) => {
  try { localStorage.setItem(QUICK_SWITCH_BOTTOM_KEY, String(value)); } catch { /* lasts until reload */ }
};
