import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

// User-page deploy: alextatarka6.github.io serves from the domain root, so no
// `base` is needed. Swapping to a custom domain later is a one-line change here
// plus a CNAME file in public/.
export default defineConfig({
  site: 'https://alextatarka6.github.io',
  integrations: [mdx()],
  vite: { plugins: [tailwindcss()] },
});
