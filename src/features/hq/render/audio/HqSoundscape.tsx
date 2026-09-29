"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import { Vector3 } from "three";
import { HqClip } from "@/features/hq/core/config";
import type { HqSimulation } from "@/features/hq/core/sim";
import { HQ_PLACE, type HqAgentFrame } from "@/features/hq/core/types";
import { isSpeakingClip, isTypingClip } from "@/features/hq/render/crowd/clipTable";
import { crewVoiceFor } from "@/lib/voice/agentVoices";
import { isForegroundSpeechActive, isPublicAddressActive, onForegroundSpeech } from "@/lib/voice/speechDuck";
import { CREW_EXCHANGES } from "./crewScript";
import { chooseAnswerer, CrewTalkPlanner, TURN_RADIUS, type AnswerCandidate, type TalkKind, type TalkPick } from "./crewTalk";
import { HqAudio, type HqAudioSource, type HqPhrase, type HqVoice } from "./hqAudio";
import { LEAD_VOICE, VoiceBankClient } from "./voiceBankClient";

/** Where captions are drawn (a DOM overlay outside the canvas); off unless the viewer asks for them. */
export type HqSubtitleSink = {
  show(slot: number, text: string, x: number, y: number, opacity: number): void;
  hide(slot: number): void;
};

export const HQ_SUBTITLE_SLOTS = 3;

/** Typists heard at once, and how near the camera they have to be (metres). */
const TYPISTS = 8;
const TYPE_RANGE = 15;
/** Speakers heard at once (at most this many intelligible voices), and how near. */
const TALKERS = HQ_SUBTITLE_SLOTS;
const TALK_RANGE = 22;
/** Within this many metres a speaker says real phrases; farther off, a murmur. */
const VOICE_RANGE = 18;
/** Lines that open an exchange (a question wants someone to answer it). */
const ASK_LINES = new Set(CREW_EXCHANGES.map((exchange) => exchange.ask.id));
/** A scheduled answer's talk pose is cued this long before it is heard (seconds). */
const CUE_LEAD = 0.1;
/** A phrase's level before distance (the bank is levelled to one loudness). */
const PHRASE_LEVEL = 1.1;
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
  /** The murmur (far off, or while there is no bank). */
  voice: HqVoice | null;
  nextAt: number;
  phrase: number;
  seed: number;
  /** The agent's voice in the bank. */
  voiceId: string | null;
  /** The phrase playing, what it says (for captions), and what comes next. */
  playing: HqPhrase | null;
  text: string;
  planned: TalkPick | null;
  /** No new phrase before this audio time. */
  restUntil: number;
  /** Audio time the phrase playing (or scheduled) starts. */
  startsAt: number;
  /** A scheduled answer's start: the talk pose is cued then (sim.cueTalk); -1 when none is due. */
  cueAt: number;
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

const newTalker = (): Talker => ({
  id: null,
  src: null,
  voice: null,
  nextAt: 0,
  phrase: 0,
  seed: 0,
  voiceId: null,
  playing: null,
  text: "",
  planned: null,
  restUntil: 0,
  startsAt: 0,
  cueAt: -1,
});

/**
 * The HQ's soundscape: keyboards and mice at the desks near the camera, and
 * the crew's talk where people chat — their real phrases in their own voices
 * up close (the voice bank, scripts/voice-bank.mjs), a muffled murmur farther
 * off or while no bank has been rendered. Voice, not text: captions only when
 * a sink is given (off by default). Reads the simulation's frame; renders
 * nothing into the scene.
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
  const bank = useMemo(() => new VoiceBankClient(() => audio.context), [audio]);
  const planner = useMemo(() => new CrewTalkPlanner(), []);
  const size = useThree((state) => state.size);
  const typists = useRef<Typist[]>(
    Array.from({ length: TYPISTS }, () => ({ id: null, src: null, nextAt: 0, burst: 0, pitch: 1, level: 1 })),
  );
  const talkers = useRef<Talker[]>(Array.from({ length: TALKERS }, newTalker));
  const scratch = useRef({ near: new Int32Array(64), dist: new Float32Array(64) });
  const talkScratch = useRef({ near: new Int32Array(64), dist: new Float32Array(64) });
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

  useEffect(() => {
    bank.start();
    return () => bank.dispose();
  }, [bank]);

  // Dev tools: the planner's log of scheduled phrases (timing checks).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const w = window as unknown as { __hqCrewTalk?: CrewTalkPlanner; __hqCrewSlots?: Talker[] };
    w.__hqCrewTalk = planner;
    w.__hqCrewSlots = talkers.current;
    return () => {
      if (w.__hqCrewTalk === planner) delete w.__hqCrewTalk;
    };
  }, [planner]);

  // The crew's voices duck while «Система штаба», AM7 or a spoken reply is heard.
  useEffect(() => {
    audio.duckVoices(isForegroundSpeechActive(), isPublicAddressActive());
    return onForegroundSpeech((speaking, strong) => audio.duckVoices(speaking, strong));
  }, [audio]);

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
    // arrays or objects are created per frame (only when a phrase starts).

    // --- Keyboards ---------------------------------------------------------------
    const slots = typists.current;
    if (f && live) {
      const { near, dist } = scratch.current;
      let count = 0;
      for (let i = 0; i < f.count && count < near.length; i++) {
        if (!isTypingClip(f.clip[i])) continue;
        const dx = f.x[i] - cx;
        const dy = KEYBOARD_Y - cy;
        const dz = f.z[i] - cz;
        const d = dx * dx + dy * dy + dz * dz;
        if (d > TYPE_RANGE * TYPE_RANGE) continue;
        near[count] = i;
        dist[count] = d;
        count++;
      }
      const take = nearestFirst(near, dist, count, TYPISTS);
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

    // --- Talk -------------------------------------------------------------------
    // The nearest speakers get a slot: anyone in a conversation the voices lead
    // (a seated pair, a group at a spot: sim.conversing), or whose clip is in a
    // talk window. Up close (VOICE_RANGE) a slot says the agent's real phrases
    // from the voice bank, taking turns with whoever is within earshot, and the
    // phrase cues the talk pose (sim.cueTalk); farther off, or without a bank,
    // it murmurs while the clip talks. A phrase always plays to its end.
    const voices = talkers.current;
    if (!f || !sim) return;
    const now = audio.now;
    for (let slot = 0; slot < voices.length; slot++) {
      const t = voices[slot];
      if (t.id === null) continue;
      const i = indexOfId(idIndex, f.ids, t.id);
      const phraseOn = t.playing !== null && now >= 0 && t.playing.endsAt > now;
      const gone =
        i < 0 ||
        f.place[i] === HQ_PLACE.podium ||
        (f.x[i] - cx) ** 2 + (HEAD_Y - cy) ** 2 + (f.z[i] - cz) ** 2 > TALK_RANGE * TALK_RANGE ||
        (!phraseOn && !isSpeakingClip(f.clip[i], f.clipTime[i]) && !sim.conversing(i));
      if (gone) releaseTalker(t, audio, planner);
    }
    const { near, dist } = talkScratch.current;
    let count = 0;
    for (let i = 0; i < f.count && count < near.length; i++) {
      // AM7 briefing from the podium speaks with his real voice: no murmur, no crew lines.
      if (f.place[i] === HQ_PLACE.podium) continue;
      const d = (f.x[i] - cx) ** 2 + (HEAD_Y - cy) ** 2 + (f.z[i] - cz) ** 2;
      if (d > TALK_RANGE * TALK_RANGE) continue;
      if (!isSpeakingClip(f.clip[i], f.clipTime[i]) && !sim.conversing(i)) continue;
      near[count] = i;
      dist[count] = d;
      count++;
    }
    const take = nearestFirst(near, dist, count, voices.length);
    for (let k = 0; k < take; k++) {
      const i = near[k];
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
      // All slots taken: a silent one on someone no longer among the nearest
      // makes way (both halves of a conversation get a voice, not whoever came first).
      if (!free) free = idleSlot(voices, near, take, f, now, audio, planner);
      if (!free) break;
      free.id = id;
      free.seed = idSeed(id);
      free.phrase = 0;
      free.nextAt = now + free.seed * 0.4;
      free.voiceId = bankVoiceFor(bank, id, f.lead[i] === 1);
      free.restUntil = now + 0.2 + free.seed * 0.6;
      free.planned = null;
      free.text = "";
      free.cueAt = -1;
    }
    for (let slot = 0; slot < voices.length; slot++) {
      const t = voices[slot];
      if (t.id === null) {
        sink?.hide(slot);
        continue;
      }
      const i = indexOfId(idIndex, f.ids, t.id);
      const x = f.x[i];
      const z = f.z[i];
      const d2 = (x - cx) ** 2 + (HEAD_Y - cy) ** 2 + (z - cz) ** 2;
      const speaking = isSpeakingClip(f.clip[i], f.clipTime[i]);
      const phraseOn = t.playing !== null && now >= 0 && t.playing.endsAt > now;
      // A scheduled answer turns to its talk pose just before it is heard.
      if (t.cueAt >= 0 && now >= t.cueAt - CUE_LEAD) {
        if (phraseOn && t.playing) sim.cueTalk(t.id, t.playing.endsAt - now);
        t.cueAt = -1;
      }
      if (live) {
        // A wider reference distance keeps voices audible across a few rows.
        t.src ??= audio.source(3, TALK_RANGE + 6, true);
        t.src?.place(x, 1.7, z);
      }
      const src = t.src;
      const voiceId = t.voiceId;
      if (live && src && voiceId !== null && bank.available && d2 <= VOICE_RANGE * VOICE_RANGE) {
        const ctx: TalkContext = { now, cx, cy, cz, audio, bank, planner, sim, voices, f, idIndex };
        if (!speakPhrases(t, src, voiceId, i, speaking, phraseOn, ctx)) {
          murmur(t, src, speaking, now, horizon, audio);
        }
      } else if (live && src) {
        murmur(t, src, speaking, now, horizon, audio);
        // Something to say ready by the time they are close enough to be understood.
        if (voiceId !== null && bank.available && t.planned === null) {
          plan(t, voiceId, talkKind(f.clip[i]), x, z, now, bank, planner, voices, f, idIndex);
        }
      }
      // Captions (off unless a sink is given): the phrase being said.
      if (!sink) continue;
      if (!phraseOn || !t.text || now < t.startsAt) {
        sink.hide(slot);
        continue;
      }
      _v.set(x, HEAD_Y + 0.35, z).project(camera);
      if (_v.z > 1 || _v.z < -1 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) {
        sink.hide(slot);
        continue;
      }
      const opacity = Math.min(1, Math.max(0, (VOICE_RANGE + 2 - Math.sqrt(d2)) / 2));
      sink.show(slot, t.text, ((_v.x + 1) / 2) * size.width, ((1 - _v.y) / 2) * size.height, opacity);
    }
  });

  return null;
}

/** Moves the `take` nearest of `count` candidates to the front (partial selection sort; count is small). */
function nearestFirst(near: Int32Array, dist: Float32Array, count: number, want: number): number {
  const take = Math.min(want, count);
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
  return take;
}

function talkKind(clip: number): TalkKind {
  if (clip === HqClip.SitTurnL || clip === HqClip.SitTurnR) return "pair";
  if (clip === HqClip.StandLookOver) return "glance";
  return "group";
}

/** The bank voice an agent speaks with: AM7's for the lead, else a crew voice by a stable hash of the id. */
function bankVoiceFor(bank: VoiceBankClient, id: string, lead: boolean): string | null {
  if (!bank.available) return null;
  if (lead && bank.voice(LEAD_VOICE)) return LEAD_VOICE;
  return crewVoiceFor(id, bank.crewVoiceIds, LEAD_VOICE);
}

/** What speakPhrases needs besides the talker (built only for talkers within VOICE_RANGE). */
type TalkContext = {
  now: number;
  cx: number;
  cy: number;
  cz: number;
  audio: HqAudio;
  bank: VoiceBankClient;
  planner: CrewTalkPlanner;
  sim: HqSimulation;
  voices: Talker[];
  f: HqAgentFrame;
  idIndex: IdIndex;
};

/**
 * Up close: the agent's real phrases. A new one starts when the agent is in
 * a conversation (or its clip in a talk window), after the agent's rest, and
 * when nobody within earshot is talking (plus the planner's gap); a question
 * just asked nearby is answered first. The phrase leads the pose: the sim
 * turns the speaker to talk and the others to listen for its length. A
 * question's answer is scheduled at once on the audio clock, from whoever
 * next to the asker has it decoded. False when the voice has nothing to say
 * yet (a bank still rendering): the caller murmurs.
 */
function speakPhrases(
  t: Talker,
  src: HqAudioSource,
  voiceId: string,
  i: number,
  speaking: boolean,
  phraseOn: boolean,
  ctx: TalkContext,
): boolean {
  const { now, audio, bank, planner, sim, voices, f, idIndex } = ctx;
  const id = t.id;
  if (id === null) return true;
  const x = f.x[i];
  const z = f.z[i];
  const kind = talkKind(f.clip[i]);
  if (t.planned === null) plan(t, voiceId, kind, x, z, now, bank, planner, voices, f, idIndex);
  if (t.planned === null && !phraseOn) return false;
  if (t.voice) {
    t.voice.stop(now);
    t.voice = null;
  }
  if (phraseOn || now < t.restUntil || planner.waitFor(id, x, z, now) > 0) return true;
  const conversing = sim.conversing(i);
  if (!speaking && !conversing) return true;
  // A question asked nearby is answered before anything planned.
  if (planner.openQuestion(id, x, z, now) >= 0 && t.planned?.role !== "answer") {
    plan(t, voiceId, kind, x, z, now, bank, planner, voices, f, idIndex);
  }
  const pick = t.planned;
  if (!pick) return true;
  const buffer = bank.ready(voiceId, pick.line.id);
  if (!buffer) {
    t.restUntil = now + 0.1;
    return true;
  }
  const start = now + 0.04;
  // The pose follows the voice; outside a conversation only a talk window may speak.
  if (!sim.cueTalk(id, start + buffer.duration - now) && !speaking) return true;
  t.playing = audio.phrase(src.panner, buffer, start, PHRASE_LEVEL);
  if (!t.playing) return true;
  const gap = planner.spoke(id, pick, x, z, start, t.playing.endsAt);
  t.text = pick.line.text;
  t.startsAt = start;
  t.cueAt = -1;
  // The speaker keeps the same breath as everyone near (one gap, not two);
  // after a question, until its answer has had its chance.
  t.restUntil = t.playing.endsAt + (pick.role === "ask" ? planner.exchangeGap() : gap);
  t.planned = null;
  if (pick.role === "ask") scheduleAnswer(t, pick.exchange, x, z, t.playing.endsAt, ctx);
  return true;
}

/** Picks what the talker says next and starts decoding it; for a question, its answer next to them too. */
function plan(
  t: Talker,
  voiceId: string,
  kind: TalkKind,
  x: number,
  z: number,
  now: number,
  bank: VoiceBankClient,
  planner: CrewTalkPlanner,
  voices: Talker[],
  f: HqAgentFrame,
  idIndex: IdIndex,
): void {
  if (t.id === null) return;
  // A question only with someone to answer it: another voice within earshot.
  let listener = false;
  for (const o of voices) {
    if (o === t || o.id === null) continue;
    const i = indexOfId(idIndex, f.ids, o.id);
    if (i >= 0 && (f.x[i] - x) ** 2 + (f.z[i] - z) ** 2 <= TURN_RADIUS * TURN_RADIUS) listener = true;
  }
  t.planned = planner.pick(t.id, kind, x, z, now, (line) => bank.has(voiceId, line) && (listener || !ASK_LINES.has(line)));
  if (!t.planned) return;
  bank.prefetch(voiceId, t.planned.line.id);
  // Whoever is next to the asker gets the answer ready in their own voice before it is asked.
  if (t.planned.role === "ask") prefetchAnswer(voices, t, t.planned.exchange, x, z, f, idIndex, bank);
}

/**
 * A question has just been scheduled to end at `askEnd`: the talker next to
 * the asker who has the answer decoded says it right after, ANSWER_GAP on
 * the audio clock (their talk pose is cued when it starts). When nobody has
 * it ready, the answer comes through speakPhrases as soon as it is.
 */
function scheduleAnswer(asker: Talker, exchange: number, x: number, z: number, askEnd: number, ctx: TalkContext): void {
  const { now, cx, cy, cz, audio, bank, planner, sim, voices, f, idIndex } = ctx;
  const answer = CREW_EXCHANGES[exchange]?.answer;
  if (!answer) return;
  const candidates: AnswerCandidate[] = [];
  const slots: Talker[] = [];
  for (const t of voices) {
    if (t === asker || t.id === null || t.voiceId === null || !t.src) continue;
    const i = indexOfId(idIndex, f.ids, t.id);
    if (i < 0 || (f.x[i] - cx) ** 2 + (HEAD_Y - cy) ** 2 + (f.z[i] - cz) ** 2 > VOICE_RANGE * VOICE_RANGE) continue;
    if (!sim.conversing(i) && !isSpeakingClip(f.clip[i], f.clipTime[i])) continue;
    candidates.push({
      x: f.x[i],
      z: f.z[i],
      busyUntil: t.playing && t.playing.endsAt > now ? t.playing.endsAt : 0,
      ready: bank.ready(t.voiceId, answer.id) !== null,
    });
    slots.push(t);
  }
  const k = chooseAnswerer(candidates, x, z, askEnd);
  if (k < 0) return;
  const t = slots[k];
  const buffer = t.voiceId !== null ? bank.ready(t.voiceId, answer.id) : null;
  if (!buffer || !t.src || t.id === null) return;
  const start = askEnd + planner.answerGap();
  t.voice?.stop(now);
  t.voice = null;
  t.playing = audio.phrase(t.src.panner, buffer, start, PHRASE_LEVEL);
  if (!t.playing) return;
  const gap = planner.spoke(t.id, { line: answer, exchange, role: "answer" }, candidates[k].x, candidates[k].z, start, t.playing.endsAt);
  t.text = answer.text;
  t.startsAt = start;
  t.cueAt = start;
  t.restUntil = t.playing.endsAt + gap;
  t.planned = null;
}

/** Farther off, or without a bank: the synthesised murmur while the clip talks. */
function murmur(t: Talker, src: HqAudioSource, speaking: boolean, now: number, horizon: number, audio: HqAudio): void {
  if (!speaking) {
    t.voice?.stop(now);
    t.voice = null;
    return;
  }
  if (t.playing && t.playing.endsAt > now) return;
  t.voice ??= audio.voice(src.panner, 95 + t.seed * 55);
  const voice = t.voice;
  if (!voice) return;
  if (t.nextAt < now) t.nextAt = now;
  while (t.nextAt < horizon) {
    if (t.phrase <= 0) {
      t.phrase = 4 + Math.floor(Math.random() * 9);
      t.nextAt += 0.35 + Math.random() * 0.7;
      continue;
    }
    const length = 0.1 + Math.random() * 0.12;
    voice.syllable(t.nextAt, length, 0.18 + Math.random() * 0.12, Math.floor(Math.random() * 6));
    t.nextAt += length;
    t.phrase--;
  }
}

/** A slot saying nothing (no phrase playing or scheduled) on someone not among the `take` nearest, freed; or null. */
function idleSlot(
  voices: Talker[],
  near: Int32Array,
  take: number,
  f: HqAgentFrame,
  now: number,
  audio: HqAudio,
  planner: CrewTalkPlanner,
): Talker | null {
  for (const t of voices) {
    if (t.id === null || (t.playing && t.playing.endsAt > now)) continue;
    let among = false;
    for (let k = 0; k < take && !among; k++) among = f.ids[near[k]] === t.id;
    if (among) continue;
    releaseTalker(t, audio, planner);
    return t;
  }
  return null;
}

/** Frees a talker slot: its phrase fades out, its murmur stops. */
function releaseTalker(t: Talker, audio: HqAudio, planner: CrewTalkPlanner): void {
  const now = audio.now >= 0 ? audio.now : 0;
  t.voice?.stop(now);
  t.voice = null;
  if (t.playing && t.playing.endsAt > now) {
    t.playing.stop(now);
    if (t.id) planner.stopped(t.id, now);
  }
  t.playing = null;
  t.planned = null;
  t.text = "";
  t.cueAt = -1;
  t.id = null;
}

/** Before a question: the talkers next to the asker fetch its answer in their own voice. */
function prefetchAnswer(
  voices: Talker[],
  asker: Talker,
  exchange: number,
  x: number,
  z: number,
  f: HqAgentFrame,
  idIndex: IdIndex,
  bank: VoiceBankClient,
): void {
  const answer = CREW_EXCHANGES[exchange]?.answer;
  if (!answer) return;
  for (const t of voices) {
    if (t === asker || t.id === null || t.voiceId === null) continue;
    const i = indexOfId(idIndex, f.ids, t.id);
    if (i < 0 || (f.x[i] - x) ** 2 + (f.z[i] - z) ** 2 > TURN_RADIUS * TURN_RADIUS) continue;
    bank.prefetch(t.voiceId, answer.id);
  }
}
