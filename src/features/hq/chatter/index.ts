// The HQ live-chatter layer: the human-language operations traffic the боевой
// пульт shows (§3.5). One typed seam (chatterController) carries a scripted demo
// now and the scope-enforced agent runtime later; it is display only and never
// transmits anything. Demo data is clearly fictional (example.com, TEST-NET-3).

export { chatterController } from "./chatterController";
export { DEMO_CALLSIGNS } from "./demoScript";
export type {
  ChatterController,
  ChatterInput,
  ChatterKind,
  ChatterMessage,
  ChatterSeverity,
} from "./types";
