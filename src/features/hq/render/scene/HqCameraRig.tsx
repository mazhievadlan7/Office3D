"use client";

import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { Box3, type PerspectiveCamera, Vector3 } from "three";

import { buildIntroPath, sampleIntro, type HqIntroPath } from "./cameraIntro";

import type { HqLayout } from "../../core/types";
import type { HqSimulation } from "../../core/sim";
import {
  HQ_CAMERA,
  am7Pose,
  distanceLimits,
  homePose,
  mapPose,
  overviewPose,
  type HqCameraPose,
  type HqCameraPreset,
} from "./cameraMath";

export type HqCameraMode = HqCameraPreset | "free";

/** Imperative camera commands for the HUD and for picking. */
export type HqCameraApi = {
  goTo: (preset: Exclude<HqCameraPreset, "follow">) => void;
  /** Starts following an agent; false when the agent is not in the scene. */
  follow: (agentId: string) => boolean;
  stopFollow: () => void;
};

const { ACTION } = CameraControlsImpl;
const PAN_ACTIONS = ACTION.TRUCK | ACTION.SCREEN_PAN | ACTION.TOUCH_TRUCK | ACTION.TOUCH_SCREEN_PAN;
// Damping: quick while the user drives, slower and filmic for fly-tos.
const SMOOTH_DEFAULT = 0.28;
const SMOOTH_PRESET = 0.62;
// Drag events it takes to break out of follow mode, so a click's jitter does not.
const FOLLOW_BREAK_EVENTS = 4;

const _box = new Box3();
const _min = new Vector3();
const _max = new Vector3();
const _introPosition = new Vector3();
const _introTarget = new Vector3();

// The user's handling limits: distance and target bounds from the room, the
// south-east viewing quadrant. The intro lifts them for its flight.
function applyLimits(controls: CameraControlsImpl, layout: HqLayout, aspect: number) {
  const { min, max } = distanceLimits(layout, aspect);
  controls.minDistance = min;
  controls.maxDistance = max;
  controls.minAzimuthAngle = HQ_CAMERA.minAzimuth;
  controls.maxAzimuthAngle = HQ_CAMERA.maxAzimuth;
  controls.minPolarAngle = HQ_CAMERA.minPolar;
  controls.maxPolarAngle = HQ_CAMERA.maxPolar;
  const { x0, z0, x1, z1 } = layout.bounds;
  _box.set(_min.set(x0 - 1, 0, z0 - 1), _max.set(x1 + 1, Math.max(3, layout.wallHeight), z1 + 1));
  controls.setBoundary(_box);
}

function liftLimits(controls: CameraControlsImpl) {
  controls.minDistance = 0.1;
  controls.maxDistance = Infinity;
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;
  controls.minPolarAngle = 0.01;
  controls.maxPolarAngle = Math.PI - 0.01;
  controls.setBoundary();
}

function applyPose(controls: CameraControlsImpl, pose: HqCameraPose, transition: boolean): Promise<unknown> {
  return Promise.all([
    controls.moveTo(pose.tx, pose.ty, pose.tz, transition),
    controls.rotateTo(pose.azimuth, pose.polar, transition),
    controls.dollyTo(pose.distance, transition),
  ]);
}

/**
 * Camera for the HQ: camera-controls with map-style handling (left drag pans
 * along the floor, right drag orbits within the south-east quadrant, the wheel
 * dollies toward the cursor), the target clamped to the room, a cinematic
 * fly-through on first open (cameraIntro.ts; any click, wheel or key skips
 * it), fly-to presets and a follow mode that tracks one agent through the sim.
 */
export function HqCameraRig({
  layout,
  simRef,
  apiRef,
  onModeChange,
  onIntroChange,
}: {
  layout: HqLayout;
  simRef: MutableRefObject<HqSimulation | null>;
  apiRef: MutableRefObject<HqCameraApi | null>;
  onModeChange: (mode: HqCameraMode) => void;
  /** True while the opening fly-through plays. */
  onIntroChange?: (playing: boolean) => void;
}) {
  const controlsRef = useRef<CameraControlsImpl>(null);
  const size = useThree((state) => state.size);
  const aspect = size.width / Math.max(1, size.height);
  const aspectRef = useRef(aspect);
  const layoutRef = useRef(layout);
  const modeRef = useRef<HqCameraMode>("overview");
  const onModeChangeRef = useRef(onModeChange);
  const followIdRef = useRef<string | null>(null);
  const followBreakRef = useRef(0);
  const lastFollow = useRef({ x: NaN, y: NaN, z: NaN });
  const flightRef = useRef(0);
  const introPlayedRef = useRef(false);
  const introRef = useRef<{ path: HqIntroPath; start: number | null } | null>(null);
  const onIntroChangeRef = useRef(onIntroChange);
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    onModeChangeRef.current = onModeChange;
    onIntroChangeRef.current = onIntroChange;
    aspectRef.current = aspect;
    layoutRef.current = layout;
  });

  const setMode = (mode: HqCameraMode) => {
    if (modeRef.current === mode) return;
    modeRef.current = mode;
    onModeChangeRef.current(mode);
  };

  // Static handling; set once on the controls instance.
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.mouseButtons.left = ACTION.SCREEN_PAN;
    controls.mouseButtons.right = ACTION.ROTATE;
    controls.mouseButtons.middle = ACTION.DOLLY;
    controls.mouseButtons.wheel = ACTION.DOLLY;
    controls.touches.one = ACTION.TOUCH_SCREEN_PAN;
    controls.touches.two = ACTION.TOUCH_DOLLY_ROTATE;
    controls.touches.three = ACTION.TOUCH_SCREEN_PAN;
    controls.dollyToCursor = true;
    controls.smoothTime = SMOOTH_DEFAULT;
    controls.draggingSmoothTime = 0.1;
    controls.azimuthRotateSpeed = 0.55;
    controls.polarRotateSpeed = 0.45;
    controls.dollySpeed = 0.9;
    // A trackpad pinch arrives as ctrl+wheel and zooms the lens; keep it sane.
    controls.minZoom = 1;
    controls.maxZoom = 3;
    controls.boundaryEnclosesCamera = false;
  }, []);

  // Distance range and target bounds follow the room and the window shape
  // (not during the intro, which flies outside them).
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls || introRef.current) return;
    applyLimits(controls, layout, aspect);
  }, [layout, aspect]);

  const flyTo = (pose: HqCameraPose, smoothTime: number) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const flight = (flightRef.current += 1);
    controls.smoothTime = smoothTime;
    void applyPose(controls, pose, true).then(() => {
      // Only the latest flight restores the handling speed.
      if (flightRef.current === flight) controls.smoothTime = SMOOTH_DEFAULT;
    });
  };

  // Ends the fly-through: back to the user's limits and handling, landing on
  // the overview (smoothly when it was cut short).
  const finishIntro = (skipped: boolean) => {
    const controls = controlsRef.current;
    if (!controls || !introRef.current) return;
    introRef.current = null;
    const current = layoutRef.current;
    applyLimits(controls, current, aspectRef.current);
    controls.enabled = true;
    const home = homePose(current, aspectRef.current);
    if (skipped) flyTo(home, SMOOTH_PRESET);
    else void applyPose(controls, home, false);
    onIntroChangeRef.current?.(false);
  };
  const finishIntroRef = useRef(finishIntro);
  useEffect(() => {
    finishIntroRef.current = finishIntro;
  });

  // The fly-through on first mount; a plain fly-to the new overview when the layout changes.
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const home = homePose(layout, aspectRef.current);
    followIdRef.current = null;
    controls.dollyToCursor = true;
    if (!introPlayedRef.current) {
      introPlayedRef.current = true;
      introRef.current = { path: buildIntroPath(layout, home), start: null };
      liftLimits(controls);
      controls.enabled = false;
      onIntroChangeRef.current?.(true);
    } else if (!introRef.current) {
      flyTo(home, SMOOTH_PRESET);
    }
    setMode("overview");
  }, [layout]);

  // Any click, wheel or key cuts the fly-through short.
  useEffect(() => {
    const skip = () => {
      if (introRef.current) finishIntroRef.current(true);
    };
    const element = gl.domElement;
    element.addEventListener("pointerdown", skip);
    element.addEventListener("wheel", skip, { passive: true });
    window.addEventListener("keydown", skip);
    return () => {
      element.removeEventListener("pointerdown", skip);
      element.removeEventListener("wheel", skip);
      window.removeEventListener("keydown", skip);
    };
  }, [gl]);

  // User input: restore quick handling, leave presets, break follow on a real pan.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const onStart = () => {
      flightRef.current += 1;
      controls.smoothTime = SMOOTH_DEFAULT;
      followBreakRef.current = 0;
    };
    const onControl = () => {
      const panning = (controls.currentAction & PAN_ACTIONS) !== 0;
      if (modeRef.current === "follow") {
        if (!panning) return;
        followBreakRef.current += 1;
        if (followBreakRef.current < FOLLOW_BREAK_EVENTS) return;
        followIdRef.current = null;
        controls.dollyToCursor = true;
      }
      setMode("free");
    };
    controls.addEventListener("controlstart", onStart);
    controls.addEventListener("control", onControl);
    return () => {
      controls.removeEventListener("controlstart", onStart);
      controls.removeEventListener("control", onControl);
    };
  }, []);

  useEffect(() => {
    const api: HqCameraApi = {
      goTo: (preset) => {
        const current = layoutRef.current;
        const ratio = aspectRef.current;
        followIdRef.current = null;
        const controls = controlsRef.current;
        if (controls) controls.dollyToCursor = true;
        const pose =
          preset === "am7"
            ? am7Pose(current, ratio)
            : preset === "map"
              ? mapPose(current, ratio)
              : overviewPose(current, ratio);
        flyTo(pose, SMOOTH_PRESET);
        setMode(preset);
      },
      follow: (agentId) => {
        const controls = controlsRef.current;
        const point = simRef.current?.focusPoint(agentId) ?? null;
        if (!controls || !point) return false;
        followIdRef.current = agentId;
        followBreakRef.current = 0;
        lastFollow.current.x = point.x;
        lastFollow.current.y = point.y;
        lastFollow.current.z = point.z;
        // Zooming while following should stay centred on the agent.
        controls.dollyToCursor = false;
        const polar = Math.min(1.12, Math.max(0.78, controls.polarAngle));
        flyTo(
          {
            tx: point.x,
            ty: point.y,
            tz: point.z,
            azimuth: controls.azimuthAngle,
            polar,
            distance: Math.min(controls.distance, HQ_CAMERA.followDistance),
          },
          SMOOTH_PRESET,
        );
        setMode("follow");
        return true;
      },
      stopFollow: () => {
        followIdRef.current = null;
        const controls = controlsRef.current;
        if (controls) controls.dollyToCursor = true;
        setMode("free");
      },
    };
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [apiRef, simRef]);

  // After the sim has moved everyone (priority -100), before the controls
  // integrate this frame (priority -1).
  useFrame((state) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const intro = introRef.current;
    if (intro) {
      if (intro.start === null) intro.start = state.clock.elapsedTime;
      const playing = sampleIntro(intro.path, state.clock.elapsedTime - intro.start, _introPosition, _introTarget);
      void controls.setLookAt(
        _introPosition.x,
        _introPosition.y,
        _introPosition.z,
        _introTarget.x,
        _introTarget.y,
        _introTarget.z,
        false,
      );
      if (!playing) finishIntro(false);
    }
    const followId = followIdRef.current;
    if (followId && modeRef.current === "follow") {
      const point = simRef.current?.focusPoint(followId) ?? null;
      if (!point) {
        followIdRef.current = null;
        controls.dollyToCursor = true;
        setMode("free");
      } else {
        const last = lastFollow.current;
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        const dz = point.z - last.z;
        // Seated agents do not move; skip re-targeting until they do.
        if (dx * dx + dy * dy + dz * dz > 1e-4) {
          last.x = point.x;
          last.y = point.y;
          last.z = point.z;
          void controls.moveTo(point.x, point.y, point.z, true);
        }
      }
    }

    // Near/far hug the orbit distance so the depth buffer (and N8AO) keeps
    // its precision from a close-up to the 1000-desk overview.
    const perspective = state.camera as PerspectiveCamera;
    if (perspective.isPerspectiveCamera) {
      const distance = controls.distance;
      const near = Math.min(3, Math.max(0.08, distance * 0.025));
      const far = distance * 4 + 120;
      if (Math.abs(perspective.near - near) > near * 0.25 || Math.abs(perspective.far - far) > far * 0.25) {
        perspective.near = near;
        perspective.far = far;
        perspective.updateProjectionMatrix();
      }
    }
  }, -50);

  return <CameraControls ref={controlsRef} />;
}
