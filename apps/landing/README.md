# Portomatic landing page

The Portomatic landing site, built with Next.js (App Router, static export),
TypeScript, and plain CSS. Managed with pnpm.

- `app/` contains the page, layout, global styles, and typed `robots.ts` /
  `sitemap.ts` metadata routes.
- `public/` contains static assets served at the site root, including
  `llms.txt` and the `_headers` file with CSP and caching rules.
- `storyboard/` compares fifteen locally captured reference sites.
- `scripts/` captures each reference's HTML, CSS, JavaScript, fonts, and media.
- `captures/` contains generated capture data and is intentionally ignored by Git.

## Develop

```sh
pnpm install
pnpm dev          # or, from the repo root: npm run landing:dev
```

## Build

```sh
pnpm build        # or, from the repo root: npm run landing:build
```

The site is exported as fully static HTML to `out/` (`output: "export"` in
`next.config.ts`), so every page is pre-rendered for crawlers — no server
required. Deploy the `out/` directory.

## Capture references

Google Chrome is required. By default the capture script uses the macOS Chrome
application; set `CHROME_PATH` to use another executable.

Capture every storyboard reference:

```sh
npm run landing:capture
```

Capture one or more references while leaving the others unchanged:

```sh
npm run landing:capture -- morph cursor
```

Each capture is built in a temporary directory, localized, checked for missing
static assets, and moved into `apps/landing/captures/<slug>` only after the
full pipeline succeeds.

## Run the storyboard

```sh
npm run landing:storyboard
```

Open `http://127.0.0.1:4173/storyboard/`. Each reference runs on its own
`*.localhost` origin so its original styles and runtime remain isolated from
the storyboard.
