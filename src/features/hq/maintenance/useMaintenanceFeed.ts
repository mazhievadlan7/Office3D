"use client";

import { useEffect, useState } from "react";

import {
  EMPTY_MAINTENANCE_FEED,
  MAINTENANCE_STATUS_URL,
  markMaintenanceFeedOffline,
  nextMaintenanceFeed,
  parseMaintenanceStatus,
  type MaintenanceFeed,
} from "./maintenanceStatus";

/** How often the HQ asks the server how full the archive is, while the tab is visible. */
export const MAINTENANCE_POLL_MS = 20_000;
/** The slower pace after a failed poll (server restarting, signed out, older server). */
export const MAINTENANCE_ERROR_POLL_MS = 60_000;

/**
 * Polls `GET /api/maintenance/status` for the HQ's archive cart and console.
 *
 * - Every 20 s while the tab is visible; nothing while it is hidden, and a poll
 *   as soon as it is visible again if one is due by then.
 * - 60 s after a failed poll, until one succeeds.
 * - One request at a time, aborted on unmount.
 *
 * The returned object is stable: it is the same object until something the HQ
 * uses changes (see `nextMaintenanceFeed`), so it can be an effect dependency.
 * The server answers from memory, so a poll costs it nothing but the request.
 */
export const useMaintenanceFeed = (enabled = true): MaintenanceFeed => {
  const [feed, setFeed] = useState<MaintenanceFeed>(EMPTY_MAINTENANCE_FEED);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof fetch !== "function") return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let inFlight = false;
    // When the next poll is due (epoch ms). The first one is due at once.
    let dueAt = 0;

    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const arm = () => {
      clearTimer();
      if (disposed || inFlight || hidden()) return;
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, Math.max(0, dueAt - Date.now()));
    };

    const poll = async () => {
      if (disposed || inFlight || hidden()) return;
      inFlight = true;
      controller = new AbortController();
      const { signal } = controller;
      let ok = false;
      try {
        const response = await fetch(MAINTENANCE_STATUS_URL, {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        });
        if (response.ok) {
          const status = parseMaintenanceStatus(await response.json());
          if (status && !disposed) {
            ok = true;
            setFeed((previous) => nextMaintenanceFeed(previous, status));
          }
        }
      } catch {
        // A network error, bad JSON or an abort: handled below like any failed poll.
      } finally {
        inFlight = false;
        controller = null;
      }
      if (disposed || signal.aborted) return;
      if (!ok) setFeed(markMaintenanceFeedOffline);
      dueAt = Date.now() + (ok ? MAINTENANCE_POLL_MS : MAINTENANCE_ERROR_POLL_MS);
      arm();
    };

    const onVisibility = () => {
      if (hidden()) clearTimer();
      else arm();
    };

    document.addEventListener("visibilitychange", onVisibility);
    arm();

    return () => {
      disposed = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return feed;
};
