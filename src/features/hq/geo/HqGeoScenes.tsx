"use client";

import { useState } from "react";
import { Clapperboard, X } from "lucide-react";

import { HQ_HUD_GLASS, hqHudButtonClass } from "@/features/hq/hud/hudStyle";
import { DEMO_SCENES, type GeoScene } from "./scenes";

export type HqGeoScenesProps = {
  onPick: (scene: GeoScene) => void;
};

/**
 * «Сюжеты» — the picker that lists ready-made cinematic scenes (orbital
 * overview, Himalaya, ring of fire, Atlantic storms, Cape Canaveral, Noir
 * London …). Clicking one asks the parent to apply it: fly the camera, swap
 * the style, surface the context card. See scenes.ts for the preset data.
 */
export function HqGeoScenes({ onPick }: HqGeoScenesProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`h-8 px-2.5 font-mono text-[11px] ${hqHudButtonClass(open)}`}
        title="Готовые сюжеты: один клик — камера, стиль, слои"
      >
        <Clapperboard className="mr-1 inline h-3.5 w-3.5" />
        Сюжеты
      </button>
      {open ? (
        <div className={`absolute left-3 bottom-28 z-10 w-[300px] ${HQ_HUD_GLASS}`}>
          <header className="flex items-center justify-between border-b border-white/10 bg-black/60 px-3 py-2">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200">
              Готовые сюжеты
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Закрыть сюжеты"
              className="text-white/60 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </header>
          <ul className="max-h-[340px] divide-y divide-white/5 overflow-y-auto">
            {DEMO_SCENES.map((scene) => (
              <li key={scene.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(scene);
                    setOpen(false);
                  }}
                  className="w-full px-3 py-2 text-left transition-colors hover:bg-white/5"
                >
                  <div className="font-mono text-[11px] text-white/90">{scene.name}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-white/55">{scene.caption}</div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
