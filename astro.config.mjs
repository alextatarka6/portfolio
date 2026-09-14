import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

// Project-page deploy: this repo is served at alextatarka6.github.io/portfolio,
// not the domain root, so `base` must match the repo name. Moving to a custom
// domain (or a user-page repo) later means dropping `base` and adding a CNAME
// file in public/.
export default defineConfig({
  site: 'https://alextatarka6.github.io/portfolio',
  // Trailing slash matters: import.meta.env.BASE_URL mirrors this value
  // exactly (no slash auto-appended), and every hardcoded asset path in
  // this codebase is built by concatenating BASE_URL directly onto a
  // relative path (e.g. `${BASE_URL}favicon.svg`).
  base: '/portfolio/',
  integrations: [mdx()],
  vite: { plugins: [tailwindcss()] },
});
