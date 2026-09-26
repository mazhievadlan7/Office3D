/**
 * The HQ HUD's one visual system. Every card over the scene (the counters, the
 * top-right clock and navigation, the camera bar, the chat button, the event
 * console, the HQ panel) uses the same glass and the same buttons, so they
 * read as one set: near-black glass, a faint red edge, white text.
 */
export const HQ_HUD_GLASS = "rounded-lg border border-red-900/50 bg-black/70 shadow-lg backdrop-blur-sm";

/** A button inside a HUD card: red-edged at rest, lit red when active. */
export const hqHudButtonClass = (active: boolean): string =>
  `rounded-md border text-white transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
    active
      ? "border-red-500/60 bg-red-600/20 shadow-[0_0_14px_rgba(255,26,26,0.25)]"
      : "border-red-900/40 bg-black/40 hover:border-red-500/50 hover:bg-red-950/40"
  }`;
