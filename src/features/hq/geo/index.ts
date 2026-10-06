// The HQ «ГЕО» geo-view: a God's-Eye 3D globe for the hacker HQ.
//
// Two surfaces share one typed data layer (geoController):
//   - HqGeoView — the full-screen interactive CesiumJS globe (heavy; pulls in
//     Cesium, so load it with next/dynamic { ssr: false }).
//   - HqGeoWall — the cheap, capped-fps video-wall preview (reuses the HQ's
//     Canvas-2D GlobeView; safe to mount inside the hall's R3F Canvas).
//
// CesiumJS is Apache-2.0; the view's shape is inspired by bilawalsidhu/
// gods-eye-view (MIT), rebuilt keyless and local-first with its OpenAI voice
// dropped in favour of our local voice stack.

export { geoController } from "./geoController";
export { seedDemoGeo, HQ_ANCHOR } from "./geoData";
export type { GeoController, GeoTarget, GeoArc, GeoPoint, GeoSceneData } from "./geoTypes";
export { HqGeoWall, type HqGeoWallProps } from "./HqGeoWall";
export type { HqGeoViewProps } from "./HqGeoView";
