# Portomatic landing page

A deliberately small static landing page for Portomatic.

- `index.html` contains the complete page structure and copy.
- `styles.css` contains the visual system and responsive behavior.
- `storyboard/` compares fifteen locally captured reference sites.
- `scripts/` captures each reference's HTML, CSS, JavaScript, fonts, and media.
- `captures/` contains generated capture data and is intentionally ignored by Git.

No build step or client-side framework is required.

## Capture references

Google Chrome is required. By default the capture script uses the macOS Chrome application; set `CHROME_PATH` to use another executable.

Capture every storyboard reference:

```sh
npm run landing:capture
```

Capture one or more references while leaving the others unchanged:

```sh
npm run landing:capture -- morph cursor
```

Each capture is built in a temporary directory, localized, checked for missing static assets, and moved into `apps/landing/captures/<slug>` only after the full pipeline succeeds.

## Run the storyboard

```sh
npm run landing:dev
```

Open `http://127.0.0.1:4173/storyboard/`. Each reference runs on its own `*.localhost` origin so its original styles and runtime remain isolated from the storyboard.
