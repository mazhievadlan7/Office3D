// The hacker HQ («Штаб»). HqOffice pulls in three.js: load it with
// next/dynamic and ssr: false, and import the view-mode hook from
// "./hud/viewMode" directly where only the toggle is needed.
export { HqOffice, type HqOfficeProps } from "./HqOffice";
export { useOfficeViewMode, type OfficeViewMode } from "./hud/viewMode";
export type { HqQuality } from "./render/scene/quality";
export type { HqCameraApi, HqCameraMode } from "./render/scene/HqCameraRig";
export type { HqAgentInput, HqAgentStatus } from "./core/types";
