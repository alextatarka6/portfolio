# alextatarka6.github.io

Personal portfolio. Astro + Tailwind, static, deployed to GitHub Pages.

```bash
npm install
npm run dev      # http://localhost:4321
npm run build    # -> dist/
```

## Structure

```
src/pages/index.astro          Home: hero + bento grid + selected work
src/pages/projects/*.mdx       Case studies (frontmatter drives the layout header)
src/components/                Bento cards and shared pieces
src/layouts/Base.astro         Shell: head, nav, footer
src/layouts/Project.astro      Case-study chrome + long-form typography
src/styles/global.css          Design tokens (@theme) - colors, radius, shadows
public/emu/                    celadoncity wasm build, vendored (see below)
```

## Things worth knowing

**The Game Boy card is the real emulator.** `public/emu/` holds the WebAssembly
build of [celadoncity](https://github.com/alextatarka6/celadoncity). To refresh
it after changing the emulator:

```bash
cd ~/projects/celadoncity && ./scripts/build-web
cp web/celadoncity.js web/celadoncity.wasm web/gb-audio-worklet.js ~/projects/portfolio/public/emu/
```

`public/emu/emu.js` is a vendored copy of the emulator's frontend with one
change: an `ASSET_BASE` constant so it fetches the ROM and audio worklet from
`/emu/` rather than the page root. Re-apply that if you re-copy it.

`emu.js` binds to fixed element IDs, so only one emulator instance may exist per
page. `src/components/GameBoy.astro` supplies that markup.

Only `libbet.gb` ships — free homebrew under the zlib licence. No commercial
ROMs are distributed.

**Placeholders to fill in:**

- `public/me.jpg` — drop a square photo here and it replaces the monogram in the
  hero automatically. `.png`, `.jpeg` and `.webp` also work.
- `public/resume.pdf` — the hero's Resume button points here.
- `src/components/Research.astro` — AITAR lab details are marked with a TODO.

**Colours** live in `src/styles/global.css` under `@theme`. `--color-accent` is
the vivid amethyst used for display type; `--color-accent-deep` is the darker
tone used wherever the text is small enough to need more contrast.
