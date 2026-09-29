// Memory of the server process, sampled once a minute into a ring of 1440
// samples (a day). The service reports a level and, when it is high, what to
// do about it. It never frees memory itself: in development the growth is the
// dev server's hot-reload state, which only a restart of `npm run dev` gives
// back, and a forced full GC on a heap that size would freeze the server.

const v8 = require("node:v8");

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const LEVELS = {
  dev: { elevated: 2 * GiB, high: 3 * GiB, heapRatio: 0.8, recommendation: "restart-dev-server" },
  production: { elevated: 768 * MiB, high: 1.5 * GiB, heapRatio: 0.8, recommendation: "possible-leak" },
};

const RING_SIZE = 1440;
// The trend is fitted over the last hour.
const TREND_WINDOW_MS = 60 * 60_000;
const TREND_MIN_SPAN_MS = 10 * 60_000;
const TREND_MIN_SAMPLES = 5;

const defaultRead = () => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapLimit: v8.getHeapStatistics().heap_size_limit,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
};

/**
 * The level for one sample.
 * @returns {{level: "ok"|"elevated"|"high", recommendation: null|"restart-dev-server"|"possible-leak"}}
 */
const memoryLevel = ({ rss, heapUsed, heapLimit }, dev) => {
  const limits = dev ? LEVELS.dev : LEVELS.production;
  const heapHigh = heapLimit > 0 && heapUsed >= limits.heapRatio * heapLimit;
  if (rss >= limits.high || heapHigh) return { level: "high", recommendation: limits.recommendation };
  if (rss >= limits.elevated) return { level: "elevated", recommendation: null };
  return { level: "ok", recommendation: null };
};

/**
 * Least-squares slope of rss over time, in MB per hour, from (t, rss) pairs.
 * 0 when there are too few samples or they span too little time.
 */
const trendMbPerHour = (times, values, count) => {
  if (count < TREND_MIN_SAMPLES) return 0;
  let sumT = 0;
  let sumV = 0;
  let minT = Infinity;
  let maxT = -Infinity;
  for (let i = 0; i < count; i += 1) {
    sumT += times[i];
    sumV += values[i];
    if (times[i] < minT) minT = times[i];
    if (times[i] > maxT) maxT = times[i];
  }
  if (maxT - minT < TREND_MIN_SPAN_MS) return 0;
  const meanT = sumT / count;
  const meanV = sumV / count;
  let num = 0;
  let den = 0;
  for (let i = 0; i < count; i += 1) {
    const dt = times[i] - meanT;
    num += dt * (values[i] - meanV);
    den += dt * dt;
  }
  if (den === 0) return 0;
  const bytesPerMs = num / den;
  return Math.round(((bytesPerMs * 3_600_000) / MiB) * 10) / 10;
};

/**
 * @param {object} options
 * @param {boolean} options.dev
 * @param {() => number} [options.now]
 * @param {() => {rss, heapUsed, heapLimit, external, arrayBuffers}} [options.read]
 */
const createMemoryMonitor = ({ dev, now = () => Date.now(), read = defaultRead }) => {
  const ringT = new Float64Array(RING_SIZE);
  const ringV = new Float64Array(RING_SIZE);
  let head = 0;
  let size = 0;
  let last = null;
  // Scratch buffers for the trend window (no allocation per sample).
  const winT = new Float64Array(RING_SIZE);
  const winV = new Float64Array(RING_SIZE);

  const sample = () => {
    const at = now();
    const reading = read();
    ringT[head] = at;
    ringV[head] = reading.rss;
    head = (head + 1) % RING_SIZE;
    size = Math.min(RING_SIZE, size + 1);
    let count = 0;
    for (let i = 0; i < size; i += 1) {
      const index = (head - 1 - i + RING_SIZE) % RING_SIZE;
      if (at - ringT[index] > TREND_WINDOW_MS) break;
      winT[count] = ringT[index];
      winV[count] = ringV[index];
      count += 1;
    }
    const { level, recommendation } = memoryLevel(reading, dev);
    last = {
      rss: reading.rss,
      heapUsed: reading.heapUsed,
      heapLimit: reading.heapLimit,
      external: reading.external,
      arrayBuffers: reading.arrayBuffers,
      trendMbPerHour: trendMbPerHour(winT, winV, count),
      level,
      recommendation,
      sampledAt: at,
    };
    return last;
  };

  return {
    sample,
    /** The latest sample (taking one if there is none yet). */
    current: () => last ?? sample(),
    get size() {
      return size;
    },
  };
};

module.exports = { LEVELS, RING_SIZE, createMemoryMonitor, memoryLevel, trendMbPerHour };
