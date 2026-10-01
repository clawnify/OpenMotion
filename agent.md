# OpenMotion — agent guide

This app turns **HTML compositions into MP4 videos** using HeyGen HyperFrames.
You author compositions as plain HTML, the user drops in media (logos, product
demos), and renders run on the managed Clawnify render service. You never touch
Chrome or FFmpeg — you write HTML and call this app's API.

Base URL: this app's own origin. All endpoints are under `/api`.

## Applying the deploy answers

The deploy page asks two questions. Use them for the user's first composition:

- `brand_name`: put it in the opening title of the first composition, and use it
  to name that composition (`<brand_name> intro`).
- `use_case`: pick the shape from it (a social ad or reel is 1080×1920, a feed
  post 1080×1080, a launch or demo clip 1920×1080) and write a short first
  composition for it. Do not render it: the editor's preview is the video.

If an answer is missing, keep the starter composition as it is.

## Requests from the app's chat

The app opens the chat with a draft the user sends:

- From the video list: `Make a new video in OpenMotion: <brief>`. Create the
  composition and open it for them at the app path `/<composition id>`. Export
  only if they asked for a file (see Exporting).
- From the editor: `In the OpenMotion video "<name>": …`, sometimes naming a
  clip and its start time. The chat context carries the open video as a record
  of type `composition` with its `id`. Change that composition with
  `PUT /api/compositions/{id}`; do not create a new one.

The editor reloads the preview after your write and keeps the playhead where
it was. When the user has unsaved edits it asks them before taking your
version, so a write never silently replaces their work.

## Composition format (HyperFrames)

A composition is one HTML fragment with a root element carrying
`data-composition-id`, `data-width`, `data-height` and `data-duration` (the
video's length in seconds). Timed elements get
`class="clip"` plus `data-start` / `data-duration` (seconds) /
`data-track-index`. Animate with a **paused** GSAP timeline registered on
`window.__timelines[<composition-id>]`.

```html
<div id="root" data-composition-id="promo" data-start="0" data-duration="8" data-width="1920" data-height="1080"
     style="width:1920px;height:1080px;background:#0b1020;position:relative;font-family:sans-serif">
  <img src="assets/logo.png" class="clip" data-start="0" data-duration="6" data-track-index="0"
       style="position:absolute;top:80px;left:80px;width:160px" />
  <h1 id="title" class="clip" data-start="0.5" data-duration="6" data-track-index="0"
      style="position:absolute;top:48%;left:50%;color:#fff;font-size:90px">
    Introducing Northwind
  </h1>
  <video src="assets/demo.mp4" class="clip" data-start="2" data-duration="6" data-track-index="1"
         style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    gsap.set("#title", { xPercent: -50, yPercent: -50 }); // centre it with GSAP, not CSS
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: 40, duration: 1 }, 0.5);
    window.__timelines = window.__timelines || {};
    window.__timelines["promo"] = tl;
  </script>
</div>
```

Keep `data-composition-id` unique per composition and matching the
`window.__timelines` key.

### Centre with GSAP, never with a CSS transform

A GSAP tween that moves or scales an element (`x`, `y`, `scale`, `rotation`)
rewrites its whole `transform`, so a CSS `transform: translate(-50%,-50%)` on
the same element is thrown away and the element jumps off centre. Leave
`transform` out of the CSS and centre with `gsap.set(el, { xPercent: -50,
yPercent: -50 })`, as above. Animate transforms and opacity only: tweening
layout properties such as `letterSpacing`, `width` or `top` snaps to whole
pixels and stutters in the render.

### Length: always set the root's `data-duration`

The root's `data-duration` is where the render stops. Set it to when the last
clip ends, or later if you want a hold at the end. Without it the renderer
takes the length of your GSAP timeline, which usually ends when the entrances
finish: clips that run to 8 s would render as a 2 s video. The app guards
against this (the preview, the timeline and the render all fall back to where
the last clip ends), but state the length so the video is the one you meant.
When you lengthen a composition, raise `data-duration` with it.

## Embedding the user's media

Media the user uploads lives in the **Media library** and is referenced from the
HTML by path: `assets/<key>`. Reference it as `<img src="assets/logo.png">` or
`<video src="assets/demo.mp4">`. At render time the app automatically ships only
the assets your HTML actually references — you don't attach them manually.

To list what's available: `GET /api/assets` → `[{ key, name, content_type }]`.
Use the exact `key` in `assets/<key>`. (Users upload via the Media tab; you can
also upload programmatically with a multipart `POST /api/assets`.)

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/compositions` | List compositions |
| GET  | `/api/compositions/{id}` | Get one (includes `html`) |
| POST | `/api/compositions` | Create `{ name, description?, html?, fps? }` |
| PUT  | `/api/compositions/{id}` | Update any of `name/description/html/fps` |
| DELETE | `/api/compositions/{id}` | Delete |
| GET  | `/api/assets` | List uploaded media |
| POST | `/api/renders` | Export an MP4 `{ composition_id }` (only when a file is asked for) → returns the job |
| GET  | `/api/renders` | List exports |

## Authoring flow

1. Read the brief. Pick dimensions (1920×1080 landscape, 1080×1080 square,
   1080×1920 vertical/reel) from the use case.
2. `GET /api/assets` to see the user's logo / demo clips and their `key`s.
3. Write the composition HTML, referencing media as `assets/<key>`, and
   `POST /api/compositions` (or `PUT` to revise an existing one).
4. Stop there. The preview in the editor is the video, frame for frame, so
   there is nothing to render to show the user a result.

## Exporting (only when a file is asked for)

Rendering makes an MP4 file. It takes up to a minute and is metered, so do it
only when the user asks for a file: to download it, post it, send it or attach
it. "Make me a video" or "change the title" never needs a render; "send me the
video" or "export it" does.

`POST /api/renders { composition_id }` blocks until the MP4 is ready and
returns the job with `output_url`, or `status: "failed"` with an `error` to fix
and retry. Share the `output_url`. In the app this is the **Export** button.

## How rendering works (so you can reason about failures)

`POST /api/renders` ships your composition HTML + referenced assets to
Clawnify's managed render service, which runs `hyperframes render` and returns
the MP4. The app itself does no rendering — it's a thin client. Failures usually
mean: a malformed composition (missing `data-composition-id`/dimensions, or a
timeline not registered on `window.__timelines`), or a referenced asset path
that doesn't match a real `key`. Read `error`, fix the HTML, render again.
