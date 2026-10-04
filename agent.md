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

### Motion: vary it, don't animate everything the same way

Mechanical motion is the tell of a generated video: the same ease, the same
duration, the same "fade up 30px" on every element. Vary all three.

- **Start at 0.1-0.3s, never t=0.** A zero-delay first entrance reads as a jump
  cut. Offset it.
- **Vary the ease.** Don't put `power2.out` on everything. `expo.out` is a
  confident entrance, `sine.inOut` a soft one, `back.out` a playful one. No more
  than two tweens should share one ease. Entrances use an `.out` ease (fast,
  then settling); the occasional exit uses `.in`.
- **Vary the duration.** The slowest move should be roughly 3x the fastest. Fast
  (0.15-0.3s) reads as energy, slow (0.5-0.8s) as weight. Not 0.5s on everything.
- **Vary the entrance direction.** Not `y: 50, opacity: 0` on every element:
  come from the left, from the right, from `scale`, or from opacity alone.
- **Stagger by importance, not DOM order.** Whatever moves first reads as the
  most important. Overlap the entries and keep the whole stagger under ~0.5s.
- **Then let it hold.** Once everything is in, stop. Stillness after motion is
  what makes the motion land; don't keep animating for its own sake.

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

Every clip is on screen only inside its window: it appears at `data-start`
and leaves `data-duration` seconds later. A `<video>` or `<audio>` clip plays
from its own beginning within that window, and scrubbing seeks it frame for
frame, so the preview shows the frame the render will. Give a video clip a
`data-duration` (shorter trims it, longer holds its last frame) so it counts
toward the composition's length.

## Product demos of a web app (screen-recording style)

When the user asks for a demo, walkthrough or "screen recording" of a web app
at a link, the video shows that app being used: a cursor glides to a control,
clicks it, the page changes, and the camera zooms to what matters.

Build it from **stills of the real app, one per state, captured in a real
browser**, never from an `<iframe>` of the link. The renderer cannot click
inside an iframe or rewind it, and most apps refuse to be framed at all
(`frame-ancestors`). A still per state, with the cursor, click and camera
animated on top by the app, renders the same every time and works for any
page you can open.

**Plan 3 to 6 steps.** For each: the state the page is in, what to point the
viewer at (`focus`), and what gets clicked to reach the next state (`click`).
The last step has no click. Give a step with a click about 3.5 s (at least
2 s), the last one 2 to 3 s.

**If you can run Node and Chrome, use the capture script** in this repo. Write
a spec that names elements by what they say, so it still works after the app's
layout changes:

```json
{ "name": "Studio: from prompt to outputs",
  "url": "https://app.clawnify.com/demo/workspaces/studio?at=%2Fworkflows%2F5a1e0000-0000-4000-8000-000000000001",
  "wait_gone": "Loading",
  "steps": [
    { "focus": { "text": "A tidy creative studio desk", "closest": ".react-flow__node" },
      "click": { "text": "Outputs" }, "seconds": 4 },
    { "focus": { "text": "sample-output", "closest": "div:has(img)" },
      "click": { "text": "Workflows" }, "seconds": 3.5 },
    { "seconds": 2.5 } ] }
```

```sh
CHROME_PATH=/path/to/chrome pnpm demo:capture spec.json \
  --api <this app's API base> --header "Authorization: Bearer …" [--composition <id>]
```

A locator is `text` (the smallest visible element containing it, in any frame;
for a click, controls win), `selector`, or both, plus `closest` to grow the
match to an ancestor such as its card. The script screenshots each state at
1600×900, scale 2, really clicks, uploads the stills and calls the endpoint
below. With `--composition` it rebuilds that video in place: run the same
spec again whenever the app changes.

**Otherwise capture by hand** in your own browser: viewport 1600×900 at device
scale factor 2; per step, wait until the page settles, take a viewport
screenshot, record `focus` and `click` as `{x,y,w,h}` page pixels
(`getBoundingClientRect()`; inside an iframe, add the iframe's own `x`/`y`),
then really click. Upload each still with a multipart `POST /api/assets`
(field `file`) and keep the `key` it returns.

**Then build the video** with `POST /api/compositions/screen-demo`:

```json
{ "name": "Studio: from prompt to outputs",
  "steps": [
    { "asset": "studio-1.png", "seconds": 4,
      "focus": { "x": 615, "y": 253, "w": 300, "h": 180 },
      "click": { "x": 1316, "y": 55, "w": 70, "h": 28 } },
    { "asset": "studio-2.png", "seconds": 3.5,
      "focus": { "x": 551, "y": 109, "w": 247, "h": 331 },
      "click": { "x": 26, "y": 324, "w": 240, "h": 28 } },
    { "asset": "studio-3.png", "seconds": 2.5 } ] }
```

Optional: `composition_id` (rebuild that video instead of creating one),
`page` (the capture viewport, default 1600×900), `frame` (the video size,
default 1920×1080; a smaller frame scales the window down), `background` (CSS
behind the window), `accent` (the click ripple as `r,g,b`, use the brand's).
It answers like a create, with `lint`; a bad step answers 400 with `problems`.

The result is an ordinary composition: one `<img class="clip demo-step">` per
step, and a script that turns each step's `data-start`, `data-focus` and
`data-click` into the camera, cursor and click. So moving or trimming a step on
the timeline moves its motion with it, and you can add titles or captions as
more clips. Leave that script as it is; change the look around it.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/compositions` | List compositions |
| GET  | `/api/compositions/{id}` | Get one (includes `html` and `lint`) |
| POST | `/api/compositions` | Create `{ name, description?, html?, fps? }` → the row with `lint` |
| POST | `/api/compositions/screen-demo` | Create or rebuild a product demo from captured stills (see above) |
| PUT  | `/api/compositions/{id}` | Update any of `name/description/html/fps` → the row with `lint` |
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
4. Read `lint` in the response (see Lint). If `errors` is above 0, fix each
   finding and `PUT` again before you report back.
5. Stop there. The preview in the editor is the video, frame for frame, so
   there is nothing to render to show the user a result.

## Lint

Every create, update and single read answers with `lint`: HyperFrames' own
linter run on the composition as the renderer will load it.

```json
"lint": { "errors": 1, "warnings": 0, "findings": [
  { "severity": "error", "code": "gsap_css_transform_conflict",
    "message": "...", "fix": "...", "line": 14 } ] }
```

These are mistakes that render without failing and look wrong in the MP4: a CSS
`transform` a GSAP tween throws away (the title is no longer centred), a
timeline never registered on `window.__timelines` (nothing moves), a tween on a
non-transform property, `Math.random()`. `fix` says what to change and `line`
is the line in the HTML you sent. `findings` lists at most 10, errors first;
the counts cover all of them. `lint` is `null` when the HTML is empty.

Fix every error before you report back. Warnings are worth fixing when the fix
is small. The editor shows the same list to the user as an "issues" badge, with
an "Ask AI to fix" button that sends you the findings.

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
