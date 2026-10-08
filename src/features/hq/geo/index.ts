// The HQ «ГЕО» geo-view: a God's-Eye 3D globe for the hacker HQ.
//
// One surface: HqGeoView — the full-screen interactive CesiumJS globe (heavy;
// pulls in Cesium, so load it with next/dynamic { ssr: false }). The old
// cheap 2D wall preview was removed — the only globe we show is the realistic
// photoreal one, opened full-screen.
//
// CesiumJS is Apache-2.0; the view's shape is inspired by bilawalsidhu/
// gods-eye-view (MIT), rebuilt keyless and local-first with its OpenAI voice
// dropped in favour of our local voice stack.

export { geoController } from "./geoController";
export { seedDemoGeo, HQ_ANCHOR } from "./geoData";
export type { GeoController, GeoTarget, GeoArc, GeoPoint, GeoSceneData } from "./geoTypes";
export type { HqGeoViewProps } from "./HqGeoView";
