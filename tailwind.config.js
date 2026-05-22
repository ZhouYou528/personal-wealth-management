/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/client/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'hsl(var(--bg))',
        surface: 'hsl(var(--surface))',
        'surface-2': 'hsl(var(--surface-2))',
        border: 'hsl(var(--border))',
        'border-strong': 'hsl(var(--border-strong))',
        text: 'hsl(var(--text))',
        'text-2': 'hsl(var(--text-2))',
        'text-3': 'hsl(var(--text-3))',
        up: 'hsl(var(--up))',
        down: 'hsl(var(--down))',
        warn: 'hsl(var(--warn))',
        'up-soft': 'hsl(var(--up-soft))',
        'down-soft': 'hsl(var(--down-soft))',
        accent: 'hsl(var(--accent))',
        'accent-soft': 'hsl(var(--accent-soft))',
        'accent-deep': 'hsl(var(--accent-deep))',
      },
      fontFamily: {
        sans: ['Geist', 'sans-serif'],
        mono: ['Geist Mono', 'monospace'],
        display: ['Instrument Serif', 'serif'],
      },
      fontSize: {
        hero: ['48px', { lineHeight: '1', fontWeight: '600', letterSpacing: '-0.025em' }],
        'page-title': ['28px', { lineHeight: '1.2', fontWeight: '600', letterSpacing: '-0.02em' }],
        'section-h2': ['17px', { lineHeight: '1.4', fontWeight: '600' }],
        'card-title': ['14px', { lineHeight: '1.4', fontWeight: '600' }],
        body: ['13.5px', { lineHeight: '1.5' }],
        small: ['12px', { lineHeight: '1.4' }],
        micro: ['11px', { lineHeight: '1.3', fontWeight: '500', letterSpacing: '0.06em' }],
      },
      borderRadius: {
        xs: '6px',
        sm: '10px',
        md: '14px',
        lg: '20px',
        xl: '28px',
      },
      boxShadow: {
        sm: '0 1px 3px rgba(0,0,0,.10), 0 1px 2px rgba(0,0,0,.06)',
        md: '0 4px 24px rgba(0,0,0,.13), 0 2px 8px rgba(0,0,0,.07)',
        lg: '0 20px 60px rgba(0,0,0,.18), 0 8px 20px rgba(0,0,0,.09)',
      },
      spacing: {
        4.5: '18px',
        18: '72px',
      },
    },
  },
  plugins: [],
}
