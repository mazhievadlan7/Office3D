/**
 * The HQ look for the connection screens, the studio settings and the
 * onboarding wizard: black glass, thin red edges, white type and one red
 * action per screen.
 *
 * Colours come from the theme tokens (.hq-theme in globals.css: primary is the
 * HQ red, ring its bright hover, card the near-black panel) rather than named
 * hues, so these screens follow the palette instead of restating it, and the
 * colour-owned files (colorSemanticsGuard.test.ts) stay token-only. Sizes and
 * padding are left to each call site so no two classes fight over a property.
 */

/** A panel: near-black card with a faint red edge. */
export const HQ_CARD = "rounded-lg border border-border bg-card";

/** A quieter block inside a card: tips, rows, command lines. */
export const HQ_INSET = "rounded-md border border-border bg-black/40";

/** Small caps label for fields, sections and statuses. */
export const HQ_LABEL = "font-mono uppercase tracking-[0.16em] text-white/55";

/** Text field, select or textarea; native pickers open dark too. */
export const HQ_FIELD =
  "rounded-md border border-primary/30 bg-black/60 text-white outline-none transition-colors placeholder:text-white/35 focus:border-ring/70 focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 [color-scheme:dark]";

/** The one action that matters on a screen. */
export const HQ_BUTTON_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 rounded-md bg-primary font-mono font-semibold uppercase tracking-[0.16em] text-primary-foreground shadow-[0_0_14px_rgba(255,26,26,0.25)] transition-colors enabled:hover:bg-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none";

/** Every other action. */
export const HQ_BUTTON_SECONDARY =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-black/40 font-mono font-semibold uppercase tracking-[0.16em] text-white/85 transition-colors enabled:hover:border-ring/60 enabled:hover:bg-primary/15 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

/** Actions that undo something: disconnect, clear, sign out, cancel. */
export const HQ_BUTTON_DANGER =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-ring/50 bg-primary/10 font-mono font-semibold uppercase tracking-[0.16em] text-[var(--status-running-fg)] transition-colors enabled:hover:bg-primary/25 enabled:hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

/** A borderless icon button (show token, close). */
export const HQ_ICON_BUTTON =
  "inline-flex items-center justify-center rounded-md text-white/55 transition-colors hover:bg-primary/15 hover:text-white";

/** Text that reads as "on / connected / done": pale red, never green. */
export const HQ_TEXT_ON = "text-[var(--status-running-fg)]";

/** A lit status dot, and an unlit one. */
export const HQ_DOT_ON = "bg-primary shadow-[0_0_8px_rgba(255,42,42,0.9)]";
export const HQ_DOT_OFF = "bg-white/30";

/** One choice among exclusive options (backends, voices): lit when chosen. */
export const hqOptionClass = (selected: boolean): string =>
  selected
    ? "border-ring/60 bg-primary/20 text-white shadow-[0_0_14px_rgba(255,26,26,0.25)]"
    : "border-border bg-black/40 text-white/70 hover:border-ring/50 hover:bg-primary/10 hover:text-white";
