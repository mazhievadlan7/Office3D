"use client";

import { createContext, useContext } from "react";

/**
 * Access to the Hermes-specific gateway methods (hermes.*) for panels deep in
 * the office tree, without threading the gateway client through the 3D scene.
 * `available` is true only while the office is connected to Hermes; panels
 * render nothing Hermes-specific otherwise.
 */
export type HermesControl = {
  available: boolean;
  call: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
};

const HermesControlContext = createContext<HermesControl | null>(null);

export const HermesControlProvider = HermesControlContext.Provider;

export const useHermesControl = (): HermesControl | null => {
  const control = useContext(HermesControlContext);
  return control?.available ? control : null;
};
