"use client";

import { Component, Suspense, type ReactNode } from "react";

type BoundaryProps = {
  name: string;
  resetKey: string | number;
  fallback: ReactNode;
  children: ReactNode;
};
type BoundaryState = { failed: boolean; key: string | number };

/**
 * Keeps one failing HQ module (a missing GLB, a shader that does not compile
 * on this GPU) from blanking the whole scene. Unlike SceneAssetBoundary it
 * retries when `resetKey` changes, so switching capacity gives a module that
 * failed on the old layout another chance.
 */
class HqModuleBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`HQ module "${this.props.name}" failed; the scene renders without it.`, error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Error boundary plus Suspense around one scene module. `fallback` stands in
 * both while the module suspends and after it failed.
 */
export function HqModuleSlot({
  name,
  resetKey,
  fallback = null,
  children,
}: {
  name: string;
  resetKey: string | number;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  return (
    <HqModuleBoundary name={name} resetKey={resetKey} fallback={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </HqModuleBoundary>
  );
}
