import type { Config } from "tailwindcss";

const config: Config = {
	darkMode: ["class"],
	content: [
		"./components/**/*.{js,ts,jsx,tsx,mdx}",
		"./app/**/*.{js,ts,jsx,tsx,mdx}",
	],
	theme: {
		extend: {
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			// Brand system v0.1: two voices plus mono for data. Newsreader is the
			// italic editorial accent only (headlines, taglines, >= 24px).
			fontFamily: {
				sans: ["var(--font-space-grotesk)", "system-ui", "sans-serif"],
				serif: ["var(--font-newsreader)", "Georgia", "serif"],
				mono: ["var(--font-jetbrains-mono)", "ui-monospace", "monospace"],
			},
			colors: {
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				// Brand system v0.1 palette ("warm pavement").
				ink: "#0E1116",
				deep: "#1B2230",
				slate: "#5A6275",
				mist: "#9AA0AF",
				line: "#E6E3DC",
				paper: "#F5F1EA",
				sand: "#EEE9E0",
				// Beacon carries the action and always means "a peer is near".
				// Use sparingly.
				beacon: {
					50: "#FFF1ED",
					100: "#FFE2D8",
					200: "#FFC5B1",
					300: "#FFA689",
					400: "#FF8666",
					DEFAULT: "#FF4E2B",
					500: "#FF4E2B",
					600: "#E03A1A",
					700: "#C3361B",
					800: "#8A2814",
				},
				// Darkened from #1F8A5B, #D49F1F and #C7402D so text in these
				// colours meets WCAG AA (4.5:1) on paper and on sand.
				success: "#1A7550",
				warning: "#86620F",
				danger: "#B5382A",
			},
			keyframes: {
				'accordion-down': {
					from: { height: '0' },
					to: { height: 'var(--radix-accordion-content-height)' }
				},
				'accordion-up': {
					from: { height: 'var(--radix-accordion-content-height)' },
					to: { height: '0' }
				}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out'
			}
		}
	},
	plugins: [require("tailwindcss-animate")],
};
export default config;
