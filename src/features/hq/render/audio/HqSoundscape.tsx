"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { Vector3 } from "three";
import { HqClip } from "@/features/hq/core/config";
import type { HqSimulation } from "@/features/hq/core/sim";
import { HQ_PLACE } from "@/features/hq/core/types";
import { chatterLine } from "./chatterLines";
import { HqAudio, type HqAudioSource, type HqVoice } from "./hqAudio";

/** Where the subtitles are drawn (a DOM overlay outside the canvas). */
export type HqSubtitleSink = {
  show(slot: number, text: string, x: number, y: number, opacity: number): void;
  hide(slot: number): void;
};

export const HQ_SUBTITLE_SLOTS = 3;

/** Typists heard at once, and how near the camera they have to be (metres). */
const TYPISTS = 8;
const TYPE_RANGE = 15;
/** Speakers heard (and subtitled) at once, and how near. */
const TALKERS = HQ_SUBTITLE_SLOTS;
const TALK_RANGE = 13;
/** Where a seated typist's keyboard is, in the seat frame (metres). */
const KEYBOARD_AHEAD = 0.5;
const KEYBOARD_Y = 0.77;
const HEAD_Y = 1.95;

type Typist = {
  id: string | null;
  src: HqAudioSource | null;
  nextAt: number;
  burst: number;
  pitch: number;
  level: number;
};

type Talker = {
  id: string | null;
  src: HqAudioSource | null;
  voice: HqVoice | null;
  nextAt: number;
  phrase: number;
  turn: number;
  seed: number;
  text: string;
};

const _v = new Vector3();

/**
 * Agent id to frame index, rebuilt only when the roster changes (the sim
 * replaces `frame.ids` whenever it does). Same answer as `ids.indexOf(id)`
 * (the first index of a repeated id) without scanning the roster per slot.
 */
export type IdIndex = { ids: readonly string[] | null; index: Map<string, number> };

export function indexOfId(cache: IdIndex, ids: readonly string[], id: string): number {
  if (cache.ids !== ids) {
    cache.ids = ids;
    cache.index.clear();
    for (let i = 0; i < ids.length; i++) if (!cache.index.has(ids[i])) cache.index.set(ids[i], i);
  }
  return cache.index.get(id) ?? -1;
}

function idSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * The HQ's soundscape: keyboards and mice at the desks near the camera, the
 * crew's muffled talk (with subtitles) where people chat. Reads the
 * simulation's frame; renders nothing into the scene.
 */
export function HqSoundscape({
  simRef,
  enabled,
  subtitleSinkRef,
}: {
  simRef: MutableRefObject<HqSimulation | null>;
  enabled: boolean;
  subtitleSinkRef?: MutableRefObject<HqSubtitleSink | null>;
}) {
  const audio = useMemo(() => new HqAudio(), []);
  const size = useThree((state) => state.size);
  const typists = useRef<Typist[]>(
    Array.from({ length: TYPISTS }, () => ({ id: null, src: null, nextAt: 0, burst: 0, pitch: 1, level: 1 })),
  );
  const talkers = useRef<Talker[]>(
    Array.from({ length: TALKERS }, () => ({ id: null, src: null, voice: null, nextAt: 0, phrase: 0, turn: 0, seed: 0, text: "" })),
  );
  const scratch = useRef({ near: new Int32Array(64), dist: new Float32Array(64) });
  const ids = useRef<IdIndex>({ ids: null, index: new Map() });

  useEffect(() => {
    const resume = () => audio.resume();
    window.addEventListener("pointerdown", resume, true);
    window.addEventListener("keydown", resume, true);
    return () => {
      window.removeEventListener("pointerdown", resume, true);
      window.removeEventListener("keydown", resume, true);
      audio.dispose();
    };
  }, [audio]);

  useEffect(() => audio.setEnabled(enabled), [audio, enabled]);

  useFrame((state) => {
    const sim = simRef.current;
    const sink = subtitleSinkRef?.current ?? null;
    const camera = state.camera;
    const cx = camera.matrixWorld.elements[12];
    const cy = camera.matrixWorld.elements[13];
    const cz = camera.matrixWorld.elements[14];
    const horizon = audio.horizon;
    const live = audio.running && sim !== null;
    if (live) audio.setListener(camera);
    const f = sim?.frame;
    const idIndex = ids.current;

    // Per-frame work below is plain loops over persistent slots: no closures,
    // arrays or objects are created per frame.

    // --- Keyboards ---------------------------------------------------------------
    const slots = typists.current;
    if (f && live) {
      const { near, dist } = scratch.current;
      let count = 0;
      for (let i = 0; i < f.count && count < near.length; i++) {
        if (f.clip[i] !== HqClip.SitType) continue;
        const dx = f.x[i] - cx;
        const dy = KEYBOARD_Y - cy;
        const dz = f.z[i] - cz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d > TYPE_RANGE * TYPE_RANGE) continue;
        near[count] = i;
        dist[count] = d;
        count++;
      }
      // The nearest TYPISTS of them (a partial selection sort; count is small).
      const take = Math.min(TYPISTS, count);
      for (let a = 0; a < take; a++) {
        let best = a;
        for (let b = a + 1; b < count; b++) if (dist[b] < dist[best]) best = b;
        const ti = near[a];
        near[a] = near[best];
        near[best] = ti;
        const td = dist[a];
        dist[a] = dist[best];
        dist[best] = td;
      }
      // Keep a slot on the same typist while they stay among the nearest.
      for (let n = 0; n < slots.length; n++) {
        const slot = slots[n];
        if (slot.id === null) continue;
        let still = false;
        for (let k = 0; k < take; k++) if (f.ids[near[k]] === slot.id) still = true;
        if (!still) slot.id = null;
      }
      for (let k = 0; k < take; k++) {
        const i = near[k];
        const id = f.ids[i];
        let held = false;
        let free: Typist | null = null;
        for (let n = 0; n < slots.length; n++) {
          const slot = slots[n];
          if (slot.id === id) {
            held = true;
            break;
          }
          if (free === null && slot.id === null) free = slot;
        }
        if (held) continue;
        if (!free) break;
        const seed = idSeed(id);
        free.id = id;
        free.src ??= audio.source(1.1, TYPE_RANGE + 4);
        free.nextAt = audio.now + seed * 0.5;
        free.burst = 0;
        free.pitch = 0.85 + seed * 0.3;
        free.level = 0.7 + ((seed * 7.3) % 1) * 0.3;
      }
      for (let n = 0; n < slots.length; n++) {
        const slot = slots[n];
        if (slot.id === null || !slot.src) continue;
        const i = indexOfId(idIndex, f.ids, slot.id);
        if (i < 0) {
          slot.id = null;
          continue;
        }
        const s = Math.sin(f.facing[i]);
        const c = Math.cos(f.facing[i]);
        slot.src.place(f.x[i] + s * KEYBOARD_AHEAD, KEYBOARD_Y, f.z[i] + c * KEYBOARD_AHEAD);
        // Typing rhythm: bursts of keys, a pause, now and then the space bar or
        // a mouse click. Never catch up on time spent silent.
        if (slot.nextAt < audio.now) slot.nextAt = audio.now;
        while (slot.nextAt < horizon) {
          const r = Math.random();
          if (r < 0.04) audio.mouseClick(slot.src.panner, slot.nextAt, slot.level);
          else audio.keyClick(slot.src.panner, slot.nextAt, slot.level * (0.8 + Math.random() * 0.4), slot.pitch, r < 0.14);
          if (slot.burst > 0) {
            slot.burst--;
            slot.nextAt += 0.055 + Math.random() * 0.11;
          } else {
            slot.burst = 3 + Math.floor(Math.random() * 10);
            slot.nextAt += 0.25 + Math.random() * 1.2;
          }
        }
      }
    }

    // --- Talk and subtitles ---------------------------------------------------------
    const voices = talkers.current;
    if (f) {
      // Speakers near the camera, nearest first.
      for (let slot = 0; slot < voices.length; slot++) {
        const t = voices[slot];
        if (t.id === null) continue;
        const i = indexOfId(idIndex, f.ids, t.id);
        const gone =
          i < 0 ||
          f.clip[i] !== HqClip.Talk ||
          f.place[i] === HQ_PLACE.podium ||
          (f.x[i] - cx) ** 2 + (HEAD_Y - cy) ** 2 + (f.z[i] - cz) ** 2 > TALK_RANGE * TALK_RANGE;
        if (gone) {
          t.voice?.stop(audio.now >= 0 ? audio.now : 0);
          t.voice = null;
          t.id = null;
        }
      }
      for (let i = 0; i < f.count; i++) {
        // AM7 briefing from the podium speaks with his real voice: no murmur, no chatter lines.
        if (f.clip[i] !== HqClip.Talk || f.place[i] === HQ_PLACE.podium) continue;
        const d = (f.x[i] - cx) ** 2 + (HEAD_Y - cy) ** 2 + (f.z[i] - cz) ** 2;
        if (d > TALK_RANGE * TALK_RANGE) continue;
        const id = f.ids[i];
        let held = false;
        let free: Talker | null = null;
        for (let slot = 0; slot < voices.length; slot++) {
          const t = voices[slot];
          if (t.id === id) {
            held = true;
            break;
          }
          if (free === null && t.id === null) free = t;
        }
        if (held) continue;
        if (!free) break;
        free.id = id;
        free.seed = idSeed(id);
        free.turn = Math.floor(state.clock.elapsedTime / 7);
        free.text = chatterLine(free.seed, free.turn);
        free.phrase = 0;
        free.nextAt = audio.now + free.seed * 0.4;
      }
      for (let slot = 0; slot < voices.length; slot++) {
        const t = voices[slot];
        if (t.id === null) {
          sink?.hide(slot);
          continue;
        }
        const i = indexOfId(idIndex, f.ids, t.id);
        // Sound: a phrase of syllables, a breath, another phrase.
        if (live) {
          t.src ??= audio.source(1.3, TALK_RANGE + 4);
          if (t.src && !t.voice) t.voice = audio.voice(t.src.panner, 95 + t.seed * 55);
          t.src?.place(f.x[i], 1.7, f.z[i]);
          if (t.voice) {
            if (t.nextAt < audio.now) t.nextAt = audio.now;
            while (t.nextAt < horizon) {
              if (t.phrase <= 0) {
                t.phrase = 4 + Math.floor(Math.random() * 9);
                t.nextAt += 0.35 + Math.random() * 0.7;
                continue;
              }
              const length = 0.1 + Math.random() * 0.12;
              t.voice.syllable(t.nextAt, length, 0.18 + Math.random() * 0.12, Math.floor(Math.random() * 6));
              t.nextAt += length;
              t.phrase--;
            }
          }
        }
        // Subtitle: a new line every few seconds, over the speaker's head.
        const turn = Math.floor(state.clock.elapsedTime / 6 + t.seed * 3);
        if (turn !== t.turn) {
          t.turn = turn;
          t.text = chatterLine(t.seed, turn);
        }
        if (!sink) continue;
        _v.set(f.x[i], HEAD_Y + 0.35, f.z[i]).project(camera);
        if (_v.z > 1 || _v.z < -1 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) {
          sink.hide(slot);
          continue;
        }
        const d = Math.sqrt((f.x[i] - cx) ** 2 + (HEAD_Y - cy) ** 2 + (f.z[i] - cz) ** 2);
        const opacity = Math.min(1, Math.max(0, (TALK_RANGE - d) / 3));
        sink.show(slot, t.text, ((_v.x + 1) / 2) * size.width, ((1 - _v.y) / 2) * size.height, opacity);
      }
    }
  });

  return null;
}
