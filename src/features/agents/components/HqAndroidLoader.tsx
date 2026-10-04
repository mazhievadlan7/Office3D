"use client";

import type { CSSProperties } from "react";

/**
 * The HQ's loading mascot: the android hacker of the hall (hood, fabric mask,
 * red eyes), rendered in Blender (blender/hacker/tools/loader.py) on a
 * transparent background. The motion is CSS only (globals.css, `.hq-loader*`):
 * a slow breathing red glow behind him, his eyes pulsing, and a scan line
 * passing over the figure. Everything stops under prefers-reduced-motion.
 *
 * Large (an overlay, a page's fallback): the bust with the label under it.
 * Compact (`size` under COMPACT_MAX, or `inline`): a round head crop for a
 * button or a status line, its ring and eyes pulsing.
 */

/** The bust, 512 px (overlays) and 160 px (compact crops). */
export const HQ_LOADER_IMAGE = "/office-assets/avatars/hacker-loader.webp";
export const HQ_LOADER_IMAGE_SMALL = "/office-assets/avatars/hacker-loader-160.webp";

/**
 * Where the eyes are in the render, fractions of its width and height from
 * the top left (printed by loader.py). The eye glow is laid over these.
 */
const EYES = [
  { x: 0.4409, y: 0.3102 },
  { x: 0.516, y: 0.3091 },
] as const;
/** The head's centre in the render, and how much of the render's width the compact crop shows. */
const HEAD = { x: 0.478, y: 0.3 } as const;
const HEAD_SPAN = 0.36;
const COMPACT_MAX = 48;

type HqAndroidLoaderProps = {
  /** Height of the portrait in CSS px: about 168 for an overlay, 14-24 for a compact one. */
  size?: number;
  label?: string;
  className?: string;
  labelClassName?: string;
  /** The label beside the portrait instead of under it (always compact). */
  inline?: boolean;
};

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

export function HqAndroidLoader({ size, label, className = "", labelClassName = "", inline = false }: HqAndroidLoaderProps) {
  const compact = inline || (size !== undefined && size < COMPACT_MAX);
  if (compact) {
    const px = Math.max(12, Math.round(size ?? 18));
    // The head fills the circle: the render is scaled up 1 / HEAD_SPAN and
    // shifted so the head's centre is the circle's.
    const k = 1 / HEAD_SPAN;
    const bx = (HEAD.x * k - 0.5) / (k - 1);
    const by = (HEAD.y * k - 0.5) / (k - 1);
    return (
      <span className={`inline-flex items-center gap-2 ${className}`}>
        <span
          aria-hidden
          className="hq-loader-chip relative inline-block shrink-0 rounded-full"
          style={
            {
              width: px,
              height: px,
              backgroundImage: `url(${HQ_LOADER_IMAGE_SMALL})`,
              backgroundSize: `${(k * 100).toFixed(1)}%`,
              backgroundPosition: `${pct(bx)} ${pct(by)}`,
            } as CSSProperties
          }
        />
        {label ? <span className={`font-mono text-[11px] tracking-[0.08em] text-white/65 ${labelClassName}`}>{label}</span> : null}
      </span>
    );
  }

  const px = Math.round(size ?? 168);
  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      <div aria-hidden className="hq-loader relative shrink-0" style={{ width: px, height: px }}>
        <span className="hq-loader-halo absolute inset-0" />
        <span className="hq-loader-body absolute inset-0">
          <span
            className="hq-loader-figure absolute inset-0"
            style={{ backgroundImage: `url(${HQ_LOADER_IMAGE})` } as CSSProperties}
          />
          {EYES.map((eye, k) => (
            <span
              key={k}
              className="hq-loader-eye absolute"
              style={{ left: pct(eye.x), top: pct(eye.y), width: Math.max(10, px * 0.09), height: Math.max(10, px * 0.09) }}
            />
          ))}
          {/* The scan line only lights the figure: it is masked by the render's own alpha. */}
          <span
            className="hq-loader-scan absolute inset-0"
            style={
              {
                WebkitMaskImage: `url(${HQ_LOADER_IMAGE})`,
                maskImage: `url(${HQ_LOADER_IMAGE})`,
              } as CSSProperties
            }
          />
        </span>
      </div>
      {label ? (
        <p className={`text-center font-mono text-[11px] tracking-[0.08em] text-white/65 ${labelClassName}`}>{label}</p>
      ) : null}
    </div>
  );
}
