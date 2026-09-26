/**
 * Class names shared by the HQ sidebar panels (inbox, history, board,
 * playbooks, analytics) so every tab speaks the same black / red / white
 * language: mono uppercase labels, white values, red as the only accent.
 *
 * Plain string constants on purpose: Tailwind reads the classes straight from
 * this file, and a panel composes them without any runtime work.
 */

/** Header strip at the top of a panel: title, one-line lead, actions. */
export const HQ_PANEL_HEADER = "shrink-0 border-b border-red-900/40 bg-[#070404]/80 px-4 py-3";
export const HQ_PANEL_TITLE =
  "flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-white before:h-3 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[#e3141c] before:shadow-[0_0_8px_rgba(255,26,26,0.6)] before:content-['']";
export const HQ_PANEL_LEAD = "mt-1 text-[11px] leading-4 text-white/55";

/** Small caps above a field or a group. */
export const HQ_LABEL = "font-mono text-[10px] uppercase tracking-[0.16em] text-white/60";
/** Title of a boxed section inside a panel. */
export const HQ_SECTION_TITLE =
  "flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/85 before:h-2.5 before:w-0.5 before:shrink-0 before:rounded-full before:bg-[#e3141c] before:content-['']";
/** Secondary line: timestamps, counts, hints under a value. */
export const HQ_META = "font-mono text-[10px] uppercase tracking-[0.14em] text-white/45";
export const HQ_HINT = "font-mono text-[10px] leading-4 text-white/45";
/** A value read at a glance. */
export const HQ_VALUE = "font-mono text-[11px] tabular-nums text-white";

/** Boxed surfaces. */
export const HQ_CARD = "rounded-md border border-red-900/40 bg-[#0b0707]";
export const HQ_SECTION = `${HQ_CARD} p-3`;
export const HQ_INSET = "rounded-md border border-red-900/30 bg-black/40";
const HQ_FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/50";
/** A card that is also a button (inbox row, history run, board card). */
export const HQ_CARD_BUTTON = `${HQ_CARD} w-full text-left transition-colors hover:border-red-500/50 hover:bg-red-950/40 ${HQ_FOCUS}`;
/** A ranked row inside a section (analytics lists). */
export const HQ_INSET_BUTTON = `${HQ_INSET} block w-full text-left transition-colors hover:border-red-500/50 hover:bg-red-950/40 ${HQ_FOCUS}`;
export const HQ_CARD_BUTTON_SELECTED = `w-full rounded-md border border-red-500/60 bg-red-600/20 text-left shadow-[0_0_14px_rgba(255,26,26,0.18)] transition-colors ${HQ_FOCUS}`;

/** Nothing to show yet. */
export const HQ_EMPTY =
  "rounded-md border border-dashed border-red-900/40 px-3 py-6 text-center font-mono text-[11px] leading-4 text-white/45";

/** Form fields: black glass, red edge, red focus ring, dark native pickers. */
const HQ_FIELD_BASE =
  "w-full rounded-md border border-red-900/50 bg-black/60 px-2.5 py-2 text-white outline-none scheme-dark transition-colors placeholder:text-white/35 hover:border-red-600/45 focus:border-red-500/70 focus:ring-2 focus:ring-red-500/30 disabled:cursor-not-allowed disabled:opacity-50";
export const HQ_FIELD = `${HQ_FIELD_BASE} font-mono text-[11px]`;
/** Free text (titles, descriptions, notes) reads better in the text face. */
export const HQ_FIELD_PROSE = `${HQ_FIELD_BASE} text-[13px] leading-5`;
/** The option list of a native select opens on its own surface; keep it ours. */
export const HQ_SELECT = `${HQ_FIELD} cursor-pointer [&>option]:bg-[#0b0707] [&>option]:text-white`;
export const HQ_CHECKBOX = "h-3.5 w-3.5 shrink-0 cursor-pointer accent-[#e3141c] scheme-dark";

/** Buttons. */
const HQ_BUTTON_BASE = `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${HQ_FOCUS}`;
export const HQ_BUTTON_PRIMARY = `${HQ_BUTTON_BASE} border-red-500/60 bg-[#e3141c] text-white shadow-[0_0_14px_rgba(255,26,26,0.25)] hover:bg-[#ff2a2a] disabled:hover:bg-[#e3141c]`;
export const HQ_BUTTON_SECONDARY = `${HQ_BUTTON_BASE} border-red-600/35 bg-black/50 text-white/85 hover:border-red-500/50 hover:bg-red-950/40 hover:text-white`;
export const HQ_BUTTON_DANGER = `${HQ_BUTTON_BASE} border-red-500/45 bg-red-950/40 text-red-300 hover:border-red-500/70 hover:bg-red-900/50 hover:text-white`;

/** Badges. */
const HQ_BADGE_BASE =
  "shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase leading-none tracking-[0.14em]";
export const HQ_BADGE = `${HQ_BADGE_BASE} border border-red-600/35 bg-red-950/40 text-white/85`;
export const HQ_BADGE_MUTED = `${HQ_BADGE_BASE} border border-white/10 bg-white/[0.04] text-white/60`;
export const HQ_BADGE_ACCENT = `${HQ_BADGE_BASE} bg-[#e3141c] text-white shadow-[0_0_10px_rgba(255,26,26,0.35)]`;
export const HQ_BADGE_ERROR = `${HQ_BADGE_BASE} border border-red-500/50 bg-red-950/60 text-red-400`;

/** Status dots: live work glows red, finished is white, idle is dim. */
const HQ_DOT = "h-1.5 w-1.5 shrink-0 rounded-full";
export const HQ_DOT_LIVE = `${HQ_DOT} bg-[#ff2a2a] shadow-[0_0_6px_rgba(255,42,42,0.9)]`;
export const HQ_DOT_DONE = `${HQ_DOT} bg-white`;
export const HQ_DOT_IDLE = `${HQ_DOT} bg-white/30`;
export const HQ_DOT_ERROR = `${HQ_DOT} bg-red-400 ring-2 ring-red-500/30`;
export const HQ_DOT_REVIEW = `${HQ_DOT} bg-red-300`;

/** Inline notices. */
const HQ_NOTICE_BASE = "rounded-md border px-3 py-2 font-mono text-[11px] leading-4";
export const HQ_NOTICE_ERROR = `${HQ_NOTICE_BASE} border-red-500/50 bg-red-950/40 text-red-400`;
export const HQ_NOTICE_WARN = `${HQ_NOTICE_BASE} border-orange-400/40 bg-orange-950/30 text-orange-300`;
/** Success / info: white text with a red dot in front. */
export const HQ_NOTICE_OK = `${HQ_NOTICE_BASE} flex items-start gap-2 border-red-600/35 bg-black/50 text-white/85 before:mt-[5px] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-[#e3141c] before:shadow-[0_0_6px_rgba(255,42,42,0.8)] before:content-['']`;
