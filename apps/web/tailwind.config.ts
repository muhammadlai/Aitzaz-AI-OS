import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        nexus: { 500: '#22d3ee', 700: '#0e7490', 950: '#083344' }
      }
    }
  },
  plugins: []
} satisfies Config;
