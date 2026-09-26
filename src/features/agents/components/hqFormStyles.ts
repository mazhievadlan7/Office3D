/**
 * Class names for the agent editor and the agent settings it shows (avatar,
 * agent files, Hermes capabilities, automations), so every tab speaks the
 * HQ's black / red / white language: near-black surfaces with a red edge,
 * white text, mono uppercase labels, red as the only accent.
 *
 * Plain string constants on purpose: Tailwind reads the classes straight from
 * this file, and a component composes them without any runtime work.
 */

const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50";

/** Small caps above a field or a group. */
export const HQ_FORM_LABEL = "font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/60";
/** Title of a boxed section, with a red tick in front. */
export const HQ_FORM_SECTION_TITLE =
  "flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white before:h-3 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[#e3141c] before:shadow-[0_0_8px_rgba(255,26,26,0.6)] before:content-['']";
/** One line under a title. */
export const HQ_FORM_LEAD = "text-[12px] leading-5 text-white/65";
/** Hints, counts, provenance. */
export const HQ_FORM_HINT = "text-[11px] leading-4 text-white/50";

/** Boxed surfaces. */
export const HQ_FORM_CARD = "rounded-lg border border-red-900/40 bg-[#0b0707]";
export const HQ_FORM_SECTION = `${HQ_FORM_CARD} px-4 py-3`;
/** A row or note inside a card. */
export const HQ_FORM_INSET = "rounded-md border border-red-900/30 bg-black/40";

/** Form fields: black glass, red edge, red focus ring, dark native pickers. */
const FIELD_BASE =
  "rounded-md border border-red-900/50 bg-black/60 text-white caret-red-500 outline-none scheme-dark transition-colors placeholder:text-white/35 hover:border-red-600/45 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-50";
export const HQ_FORM_FIELD = `${FIELD_BASE} px-2.5 py-1.5 text-[12px]`;
/** A native select: the option list opens on its own surface, keep it ours. */
export const HQ_FORM_SELECT = `${HQ_FORM_FIELD} cursor-pointer [&>option]:bg-[#0b0707] [&>option]:text-white`;
/** Long text (agent files): mono, roomy, red selection. */
export const HQ_FORM_TEXTAREA = `${FIELD_BASE} px-4 py-3 font-mono text-[13px] leading-6 selection:bg-red-600/40`;
export const HQ_FORM_CHECKBOX = "h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#e3141c] scheme-dark disabled:cursor-not-allowed disabled:opacity-50";

/** Buttons. */
const BUTTON_BASE = `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-mono text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS}`;
export const HQ_FORM_BUTTON_PRIMARY = `${BUTTON_BASE} border-red-500/60 bg-[#e3141c] px-3 py-2 text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] hover:bg-[#ff2a2a] disabled:shadow-none disabled:hover:bg-[#e3141c]`;
export const HQ_FORM_BUTTON_SECONDARY = `${BUTTON_BASE} border-red-600/35 bg-black/50 px-3 py-2 text-white/85 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white disabled:hover:border-red-600/35 disabled:hover:bg-black/50`;
export const HQ_FORM_BUTTON_DANGER = `${BUTTON_BASE} border-red-500/45 bg-red-950/40 px-3 py-2 text-red-300 hover:border-red-500/70 hover:bg-red-900/50 hover:text-white`;
/** Compact variants for buttons inside rows. */
export const HQ_FORM_BUTTON_SMALL = `${BUTTON_BASE} border-red-600/35 bg-black/50 px-2 py-1 text-[9px] text-white/85 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white`;
export const HQ_FORM_BUTTON_SMALL_PRIMARY = `${BUTTON_BASE} border-red-500/60 bg-[#e3141c] px-2 py-1 text-[9px] text-white hover:bg-[#ff2a2a] disabled:hover:bg-[#e3141c]`;

/** A choice among several (pill, segment): selected is red glass. */
const CHOICE_BASE = `rounded-md border px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors ${FOCUS}`;
export const HQ_FORM_CHOICE = `${CHOICE_BASE} border-red-900/40 bg-black/40 text-white/65 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white`;
export const HQ_FORM_CHOICE_ACTIVE = `${CHOICE_BASE} border-red-500/60 bg-red-600/20 text-white shadow-[0_0_12px_rgba(255,26,26,0.18)]`;

/** Badges. */
const BADGE_BASE =
  "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-[0.14em]";
export const HQ_FORM_BADGE = `${BADGE_BASE} border border-red-600/35 bg-red-950/40 text-white/85`;
export const HQ_FORM_BADGE_MUTED = `${BADGE_BASE} border border-white/10 bg-white/[0.04] text-white/60`;
/** Live / current / installed: white text with a red dot. */
export const HQ_FORM_BADGE_LIVE = `${BADGE_BASE} gap-1.5 border border-red-500/45 bg-red-600/15 text-white before:h-1.5 before:w-1.5 before:rounded-full before:bg-[#ff2a2a] before:shadow-[0_0_6px_rgba(255,42,42,0.9)] before:content-['']`;
/** Needs attention (setup missing, risky): orange, used sparingly. */
export const HQ_FORM_BADGE_WARN = `${BADGE_BASE} border border-orange-400/40 bg-orange-950/30 text-orange-300`;

/** Inline notices. */
const NOTICE_BASE = "rounded-md border px-3 py-2 text-[12px] leading-5";
export const HQ_FORM_NOTICE_ERROR = `${NOTICE_BASE} border-red-500/50 bg-red-950/40 text-red-400`;
/** Plain status line under a form: success reads white, errors red. */
export const HQ_FORM_STATUS_OK = "text-[11px] text-white/75";
export const HQ_FORM_STATUS_ERROR = "text-[11px] text-red-400";
