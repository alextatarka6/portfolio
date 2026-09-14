import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

// Project-page deploy: this repo is served at alextatarka6.github.io/portfolio,
// not the domain root, so `base` must match the repo name. Moving to a custom
// domain (or a user-page repo) later means dropping `base` and adding a CNAME
// file in public/.
export default defineConfig({
  site: 'https://alextatarka6.github.io/portfolio',
  base: '/portfolio',
  integrations: [mdx()],
  vite: { plugins: [tailwindcss()] },
});
