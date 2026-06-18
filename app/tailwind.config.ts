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
      boxShadow: {
        card: "0 1px 2px rgba(16, 24, 40, 0.04), 0 4px 16px rgba(16, 24, 40, 0.06)",
        "card-dark": "0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35)",
      },
    },
  },
  plugins: [],
};

export default config;
