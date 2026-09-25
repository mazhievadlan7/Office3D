import { useCallback, useSyncExternalStore } from "react";

/**
 * Which office the screen shows: the 3D HQ or the classic retro office.
 *
 * Stored in localStorage and read through useSyncExternalStore, like the
 * other persisted office toggles. `memoryValue` keeps the choice for the
 * session when storage is unavailable (private mode), and a `storage` event
 * from another tab clears it so that tab's choice wins.
 */

export type OfficeViewMode = "hq" | "classic";

const STORAGE_KEY = "office3d-view-mode";
const DEFAULT_MODE: OfficeViewMode = "hq";

let memoryValue: OfficeViewMode | null = null;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const read = (): OfficeViewMode => {
  if (memoryValue !== null) return memoryValue;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "classic" ? "classic" : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
};

const write = (mode: OfficeViewMode): void => {
  memoryValue = mode;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage may be unavailable; the in-memory value still applies.
  }
  emit();
};

const subscribe = (onChange: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    memoryValue = null;
    onChange();
  };
  listeners.add(onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
};

// The server cannot know the stored choice; it renders the default and the
// client switches after hydration if the user picked the classic office.
const getServerSnapshot = (): OfficeViewMode => DEFAULT_MODE;

export function useOfficeViewMode(): [OfficeViewMode, (mode: OfficeViewMode) => void] {
  const mode = useSyncExternalStore(subscribe, read, getServerSnapshot);
  const setMode = useCallback((next: OfficeViewMode) => write(next), []);
  return [mode, setMode];
}
