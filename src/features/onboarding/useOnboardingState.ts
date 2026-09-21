/**
 * useOnboardingState — Tracks whether onboarding has been completed.
 *
 * Uses localStorage so the wizard only shows once per browser.
 * The key is scoped to the Office3D app to avoid collisions.
 */
import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "office3d:onboarding:completed";

const readCompleted = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

const writeCompleted = (value: boolean): void => {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage might be unavailable in some environments.
  }
};

export type OnboardingStateReturn = {
  /** Whether the wizard should be shown. */
  showOnboarding: boolean;
  /** Mark onboarding as complete (hides the wizard). */
  completeOnboarding: () => void;
  /** Reset onboarding (shows the wizard again). */
  resetOnboarding: () => void;
};

/**
 * localStorage is external state, so it is read through useSyncExternalStore
 * rather than mirrored into useState from an effect. `storage` only fires in
 * other tabs, so writes from this one notify subscribers explicitly.
 */
const listeners = new Set<() => void>();

const emitChange = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (onStoreChange: () => void): (() => void) => {
  listeners.add(onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
};

/**
 * The server cannot know the answer, so it reports "not known yet" and the
 * wizard stays hidden until the client snapshot arrives. This keeps the
 * hydrated markup identical to the server's and avoids a flash of the wizard.
 */
const getServerSnapshot = (): boolean | null => null;

export const useOnboardingState = (): OnboardingStateReturn => {
  const completed = useSyncExternalStore<boolean | null>(
    subscribe,
    readCompleted,
    getServerSnapshot
  );

  const completeOnboarding = useCallback(() => {
    writeCompleted(true);
    emitChange();
  }, []);

  const resetOnboarding = useCallback(() => {
    writeCompleted(false);
    emitChange();
  }, []);

  return {
    showOnboarding: completed === false,
    completeOnboarding,
    resetOnboarding,
  };
};
