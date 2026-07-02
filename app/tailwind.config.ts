import type { Config } from "tailwindcss";

const config: Config = {
  // Toggle dark mode by adding the `dark` class on <html>.
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // ── Service colour system (one hue per feature, light + dark) ─────────
      //   ブランド / コーチ / 食事   = accent fresh-green (below)
      //   運動（筋トレ）             = violet (power)
      //   有酸素・消費カロリー       = orange (energy)
      //   睡眠                     = indigo (rest)
      //   データ（傾向・カレンダー）  = sky
      //   PFC                      = rose(P) / amber(F) / sky(C)
      //   食事タイプ                = 朝 amber / 昼 sky / 夕 indigo / 間食 rose
      // Tailwind's stock hues are used for those so light/dark contrast stays
      // guaranteed; only the brand hues (navy/accent) are custom scales.
      colors: {
        // Deep-forest charcoal — the dark theme base. (Kept under the historic
        // "navy" name so every existing dark: class re-tints app-wide; the hue
        // family is now a green-tinted near-black that pairs with the brand
        // green instead of the old blue navy.)
        navy: {
          50: "#eef4f1",
          100: "#d9e6e0",
          200: "#b5ccc3",
          300: "#8cab9f",
          400: "#63887a",
          500: "#4a6b5f",
          600: "#385249",
          700: "#2b403a",
          800: "#1e2e29",
          900: "#15221e",
          950: "#0d1613",
        },
        accent: {
          // A fresh, vivid green — reads as "health & energy" in both themes.
          // Full 50–900 scale so surfaces can tint/gradient with a single,
          // consistent hue family instead of ad-hoc opacities.
          50: "#eefbf3",
          100: "#d4f5e2",
          200: "#a8ebc8",
          300: "#72dba7",
          400: "#3cc484",
          500: "#17a865",
          600: "#0e8752",
          700: "#0d6b43",
          800: "#0e5537",
          900: "#0c462f",
          DEFAULT: "#17a865",
          light: "#3cc484",
          dark: "#0e8752",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Hiragino Kaku Gothic ProN",
          "Hiragino Sans",
          "Meiryo",
          "sans-serif",
        ],
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem",
        "3xl": "1.5rem",
      },
      // Premium-feel motion: a single spring-like easing + small set of named
      // micro-interaction animations reused across the UI (presentation only).
      transitionTimingFunction: {
        "spring": "cubic-bezier(0.22, 1, 0.36, 1)",
        "spring-soft": "cubic-bezier(0.34, 1.4, 0.64, 1)",
      },
      keyframes: {
        "fade-in-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "pop-in": {
          "0%": { opacity: "0", transform: "scale(0.94)" },
          "60%": { opacity: "1", transform: "scale(1.02)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "shimmer": {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-in-up": "fade-in-up 0.5s cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-in": "fade-in 0.4s ease-out both",
        "pop-in": "pop-in 0.35s cubic-bezier(0.34, 1.4, 0.64, 1) both",
        "shimmer": "shimmer 1.6s infinite",
      },
      boxShadow: {
        // Layered, lower-opacity shadows read as "lifted glass" rather than a
        // hard drop — the modern-SaaS depth cue. Multiple stacked layers give a
        // soft, believable ambient + key shadow.
        card: "0 1px 2px rgba(16, 24, 40, 0.04), 0 6px 16px -4px rgba(16, 24, 40, 0.06), 0 16px 36px -12px rgba(16, 24, 40, 0.08)",
        "card-dark": "0 1px 2px rgba(0, 0, 0, 0.35), 0 8px 24px -6px rgba(0, 0, 0, 0.4), 0 20px 48px -16px rgba(0, 0, 0, 0.5)",
        "card-hover": "0 2px 4px rgba(16, 24, 40, 0.05), 0 12px 28px -6px rgba(16, 24, 40, 0.10), 0 28px 56px -16px rgba(16, 24, 40, 0.12)",
        "card-hover-dark": "0 2px 6px rgba(0, 0, 0, 0.4), 0 16px 36px -8px rgba(0, 0, 0, 0.5), 0 32px 64px -20px rgba(0, 0, 0, 0.6)",
        "glow-accent": "0 8px 24px -6px rgba(23, 168, 101, 0.45)",
        // Service-colour glows (see the service palette note above `colors`).
        "glow-energy": "0 8px 24px -6px rgba(249, 115, 22, 0.4)",
        "glow-rest": "0 8px 24px -6px rgba(129, 140, 248, 0.35)",
        "glow-power": "0 8px 24px -6px rgba(139, 92, 246, 0.35)",
        "inner-top": "inset 0 1px 0 0 rgba(255, 255, 255, 0.06)",
      },
    },
  },
  plugins: [],
};

export default config;
