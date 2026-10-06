import type { NextConfig } from "next";
import path from "node:path";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
      "img-src 'self' data: blob: http: https:",
      "font-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline' https:",
      // 'unsafe-eval' is required by Next.js dev mode (source maps, HMR).
      // In production it is dropped — React and Three.js do not need eval.
      // 'wasm-unsafe-eval' stays in production: CesiumJS compiles WebAssembly
      // (tile/mesh decoders) in the ГЕО globe. It permits WASM compilation only,
      // not JavaScript eval.
      ...(process.env.NODE_ENV !== "production"
        ? ["script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:"]
        : ["script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:"]),
      // connect-src is intentionally broad: gateway URLs are user-configured
      // at runtime and cannot be enumerated at build time.
      // Restrict further when a fixed deployment target is known.
      // blob: lets GLTFLoader fetch textures embedded in .glb files, which it
      // hands to createImageBitmap through same-origin blob URLs.
      "connect-src 'self' blob: ws: wss: http: https:",
      "media-src 'self' blob: data: http: https:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "Permissions-Policy",
    // geolocation for this origin only: the HQ clock follows the viewer's
    // location (the position is turned into a time zone in the browser).
    value: "camera=(), microphone=(self), geolocation=(self), browsing-topics=()",
  },
  {
    key: "Cross-Origin-Resource-Policy",
    value: "same-origin",
  },
];

if (process.env.NODE_ENV === "production") {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  });
}

const nextConfig: NextConfig = {
  // React Compiler: components and hooks are memoized automatically, so a
  // parent re-render (the office screen updates several times a second with
  // a live team) no longer re-renders and recomputes everything below it.
  reactCompiler: true,
  // No Next.js dev-tools badge (the "N" bottom-left) over the HQ; build and
  // runtime errors are still shown in development.
  devIndicators: false,
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
