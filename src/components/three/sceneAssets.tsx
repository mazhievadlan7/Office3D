"use client";

import { Component, Suspense, type ReactNode } from "react";
import { Environment } from "@react-three/drei";
import { configureTextBuilder } from "troika-three-text";

/**
 * Everything the 3D scenes load is served by Office3D itself.
 *
 * drei and troika reach for public CDNs by default: the "city" environment
 * preset comes from raw.githack.com, and 3D text resolves its font through
 * cdn.jsdelivr.net. On a server without outbound access, behind a proxy, or
 * when either CDN is down, the office failed to render at all — the HDR
 * loader throws into the React tree and takes the whole page with it. The
 * files below are copies in public/office-assets, so the office does not
 * depend on anyone else being up.
 */

// Poly Haven's Potsdamer Platz (CC0), the file drei's "city" preset points at.
export const OFFICE_ENVIRONMENT_HDR = "/office-assets/hdri/potsdamer_platz_1k.hdr";

// Noto Sans (SIL OFL 1.1, see OFL-NotoSans.txt next to it), cut down to Latin,
// Greek, Cyrillic and common punctuation: every label the office draws, and
// agent names and speech in the languages it is used in. A character outside
// that set still falls back to troika's online resolver, so it renders when
// the network allows and is simply missing when it does not.
export const OFFICE_TEXT_FONT = "/office-assets/fonts/noto-sans-regular.woff";

// Must run before the first text is laid out; this module is imported by every
// component that draws 3D text, so it does.
configureTextBuilder({ defaultFontURL: OFFICE_TEXT_FONT });

type BoundaryState = { failed: boolean };

/**
 * Keeps a failed optional scene asset — lighting, a model — from unmounting
 * the office. Loaders report failure by throwing during render; without a
 * boundary that error climbs to the route and replaces the page with Next's
 * error screen. Here the asset is simply left out.
 */
export class SceneAssetBoundary extends Component<
  { name: string; children: ReactNode; fallback?: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`Scene asset "${this.props.name}" failed to load; rendering without it.`, error);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/** Image-based lighting for a scene, from the local HDR, never fatal. */
export function OfficeEnvironment() {
  return (
    <SceneAssetBoundary name="environment">
      <Suspense fallback={null}>
        <Environment files={OFFICE_ENVIRONMENT_HDR} />
      </Suspense>
    </SceneAssetBoundary>
  );
}
