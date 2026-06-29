import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { SelectedDateProvider } from "@/components/SelectedDateProvider";
import { ChatProvider } from "@/components/chat/ChatProvider";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { AuthGate } from "@/components/auth/AuthGate";
import { SyncErrorToast } from "@/components/SyncErrorToast";

export const metadata: Metadata = {
  title: "Health",
  description: "食事と筋トレのパーソナル記録",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "Health",
  },
  // Modern equivalent of the (now-deprecated) apple-mobile-web-app-capable tag
  // that appleWebApp.capable emits; keeps Chrome from logging a deprecation warning.
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0c1126" },
  ],
};

// Set the theme class before React hydrates to avoid a flash of the wrong theme.
const themeScript = `(function(){try{var t=localStorage.getItem('health-app:theme:v1');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}var r=document.documentElement;if(t==='dark'){r.classList.add('dark');}r.style.colorScheme=t;}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>
          {/* Session gate: /auth/me runs in AuthProvider; AuthGate shows the
              login/会員登録 shell until authed, then mounts the app (chat-home).
              Data providers live INSIDE the gate so per-device data is only read
              once the user is in. */}
          <AuthProvider>
            <AuthGate>
              <SelectedDateProvider>
                {/* ChatProvider lives ABOVE the router's page children so it
                    survives route changes: an in-flight reply keeps running and
                    persists (saveChat) even when the user navigates to /meal,
                    /workout, etc., and the conversation re-appears on return. */}
                <ChatProvider>{children}</ChatProvider>
              </SelectedDateProvider>
            </AuthGate>
          </AuthProvider>
          {/* Global, transient notice when a save was REJECTED by the server and
              could not sync (e.g. data over the size cap). Mounted outside the auth
              gate so it can surface on any screen; the push layer only fires it for
              non-retryable failures, so it never nags on a flaky connection. */}
          <SyncErrorToast />
        </ThemeProvider>
      </body>
    </html>
  );
}
