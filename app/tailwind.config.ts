import type { Config } from "tailwindcss";

const config: Config = {
  // Toggle dark mode by adding the `dark` class on <html>.
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Navy palette used as the base for the dark theme.
        navy: {
          50: "#eef1f8",
          100: "#d6dcef",
          200: "#aeb9de",
          300: "#8190c9",
          400: "#5a6bb0",
          500: "#3f4f93",
          600: "#2f3c73",
          700: "#242e59",
          800: "#1a2244",
          900: "#131a36",
          950: "#0c1126",
        },
        accent: {
          // A calm teal/green accent that reads as "health" in both themes.
          // Full 50–900 scale (additive) so surfaces can tint/gradient with a
          // single, consistent hue family instead of ad-hoc opacities.
          50: "#e8f7f4",
          100: "#c6ece5",
          200: "#9adcd0",
          300: "#62c8b8",
          400: "#36b2a0",
          500: "#1f9d8f",
          600: "#157a6f",
          700: "#13635b",
          800: "#134f49",
          900: "#12423e",
          DEFAULT: "#1f9d8f",
          light: "#2db3a3",
          dark: "#157a6f",
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
        "glow-accent": "0 8px 24px -6px rgba(31, 157, 143, 0.45)",
        "inner-top": "inset 0 1px 0 0 rgba(255, 255, 255, 0.06)",
      },
    },
  },
  plugins: [],
};

export default config;
