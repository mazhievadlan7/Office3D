import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, Oswald } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  title: "Office3D",
  description: "Операторская студия для шлюза OpenClaw.",
};

/**
 * One look only: the black-and-red HQ. The meta tags tell the browser the page
 * is dark before any CSS arrives, so native scrollbars, pickers and the
 * mobile address bar never flash light.
 */
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#050404",
};

/**
 * Oswald rather than Bebas Neue, and this is not a taste decision: Bebas Neue
 * has no Cyrillic at all, so every Russian heading would fall back to a system
 * font and the typography would break across the whole app. Oswald is the
 * nearest condensed display face that ships Cyrillic.
 */
const display = Oswald({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin", "cyrillic"],
});

const sans = IBM_Plex_Sans({
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin", "cyrillic"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin", "cyrillic"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The theme lives on <html>, not on a screen, so modals and popovers portaled
  // into document.body get the HQ tokens too. "dark" keeps Tailwind's dark:
  // variants on; "hq-theme" (declared after .dark in globals.css) wins every
  // token. Fixed classes, so there is no theme script and no first-paint flash.
  return (
    <html lang="ru" className="dark hq-theme" suppressHydrationWarning>
      <body className={`${display.variable} ${sans.variable} ${mono.variable} antialiased`}>
        <main className="h-screen w-screen overflow-hidden bg-background">{children}</main>
      </body>
    </html>
  );
}
