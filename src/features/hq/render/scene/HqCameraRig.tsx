"use client";

import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraControls, CameraControlsImpl } from "@react-three/drei";
import { Box3, type PerspectiveCamera, Vector3 } from "three";

import type { HqLayout } from "../../core/types";
import type { HqSimulation } from "../../core/sim";
import {
  HQ_CAMERA,
  am7Pose,
  distanceLimits,
  homePose,
  introStartPose,
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
const SMOOTH_INTRO = 1.25;
// Drag events it takes to break out of follow mode, so a click's jitter does not.
const FOLLOW_BREAK_EVENTS = 4;

const _box = new Box3();
const _min = new Vector3();
const _max = new Vector3();

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
 * dollies toward the cursor), the target clamped to the room, an intro swoop,
 * fly-to presets and a follow mode that tracks one agent through the sim.
 */
export function HqCameraRig({
  layout,
  simRef,
  apiRef,
  onModeChange,
}: {
  layout: HqLayout;
  simRef: MutableRefObject<HqSimulation | null>;
  apiRef: MutableRefObject<HqCameraApi | null>;
  onModeChange: (mode: HqCameraMode) => void;
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

  useEffect(() => {
    onModeChangeRef.current = onModeChange;
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
    controls.minAzimuthAngle = HQ_CAMERA.minAzimuth;
    controls.maxAzimuthAngle = HQ_CAMERA.maxAzimuth;
    controls.minPolarAngle = HQ_CAMERA.minPolar;
    controls.maxPolarAngle = HQ_CAMERA.maxPolar;
    // A trackpad pinch arrives as ctrl+wheel and zooms the lens; keep it sane.
    controls.minZoom = 1;
    controls.maxZoom = 3;
    controls.boundaryEnclosesCamera = false;
  }, []);

  // Distance range and target bounds follow the room and the window shape.
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const { min, max } = distanceLimits(layout, aspect);
    controls.minDistance = min;
    controls.maxDistance = max;
    const { x0, z0, x1, z1 } = layout.bounds;
    _box.set(_min.set(x0 - 1, 0, z0 - 1), _max.set(x1 + 1, Math.max(3, layout.wallHeight), z1 + 1));
    controls.setBoundary(_box);
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

  // Intro on first mount; a plain fly-to the new overview when the layout changes.
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const home = homePose(layout, aspectRef.current);
    followIdRef.current = null;
    controls.dollyToCursor = true;
    if (!introPlayedRef.current) {
      introPlayedRef.current = true;
      void applyPose(controls, introStartPose(home, controls.maxDistance), false);
      flyTo(home, SMOOTH_INTRO);
    } else {
      flyTo(home, SMOOTH_PRESET);
    }
    setMode("overview");
  }, [layout]);

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
