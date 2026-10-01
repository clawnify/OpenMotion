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
  composition for it, then render it so the user lands on a finished video.

If an answer is missing, keep the starter composition as it is.

## Requests from the app's chat

The app opens the chat with a draft the user sends:

- From the video list: `Make a new video in OpenMotion: <brief>`. Create the
  composition, render it if the user asked for a finished video, then open it
  for them at the app path `/<composition id>`.
- From the editor: `In the OpenMotion video "<name>": …`, sometimes naming a
  clip and its start time. The chat context carries the open video as a record
  of type `composition` with its `id`. Change that composition with
  `PUT /api/compositions/{id}`; do not create a new one.

The editor reloads the preview after your write and keeps the playhead where
it was. When the user has unsaved edits it asks them before taking your
version, so a write never silently replaces their work.

## Composition format (HyperFrames)

A composition is one HTML fragment with a root element carrying
`data-composition-id`, `data-width`, `data-height`. Timed elements get
`class="clip"` plus `data-start` / `data-duration` (seconds) /
`data-track-index`. Animate with a **paused** GSAP timeline registered on
`window.__timelines[<composition-id>]`.

```html
<div id="root" data-composition-id="promo" data-start="0" data-width="1920" data-height="1080"
     style="width:1920px;height:1080px;background:#0b1020;position:relative;font-family:sans-serif">
  <img src="assets/logo.png" class="clip" data-start="0" data-duration="6" data-track-index="0"
       style="position:absolute;top:80px;left:80px;width:160px" />
  <h1 id="title" class="clip" data-start="0.5" data-duration="6" data-track-index="0"
      style="position:absolute;top:48%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:90px">
    Introducing Northwind
  </h1>
  <video src="assets/demo.mp4" class="clip" data-start="2" data-duration="6" data-track-index="1"
         style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover" />
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: 40, duration: 1 }, 0.5);
    window.__timelines = window.__timelines || {};
    window.__timelines["promo"] = tl;
  </script>
</div>
```

Keep `data-composition-id` unique per composition and matching the
`window.__timelines` key.

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
| POST | `/api/renders` | Render `{ composition_id }` → returns the job |
| GET  | `/api/renders` | List render jobs |

## Authoring flow

1. Read the brief. Pick dimensions (1920×1080 landscape, 1080×1080 square,
   1080×1920 vertical/reel) from the use case.
2. `GET /api/assets` to see the user's logo / demo clips and their `key`s.
3. Write the composition HTML, referencing media as `assets/<key>`, and
   `POST /api/compositions` (or `PUT` to revise an existing one).
4. `POST /api/renders { composition_id }`. The call blocks until the MP4 is
   ready (up to ~a minute) and returns the job with `output_url`, or
   `status: "failed"` with an `error` to fix and retry.
5. Share the rendered video's `output_url`.

## How rendering works (so you can reason about failures)

`POST /api/renders` ships your composition HTML + referenced assets to
Clawnify's managed render service, which runs `hyperframes render` and returns
the MP4. The app itself does no rendering — it's a thin client. Failures usually
mean: a malformed composition (missing `data-composition-id`/dimensions, or a
timeline not registered on `window.__timelines`), or a referenced asset path
that doesn't match a real `key`. Read `error`, fix the HTML, render again.
