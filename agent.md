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
  only if they asked for a file (see Exporting). If the brief names a link to
  a web app and asks for a demo, walkthrough or screen recording of it, follow
  "Product demos of a web app".
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
Use the exact `key` in `assets/<key>`. You can upload too: a multipart
`POST /api/assets` with the file in the field `file` (and `duration` in seconds
for a video or sound, when you know it). The key is made from the file name,
lowercased and de-duplicated, so reference the `key` the response returns, not
the name you sent.

When the user attaches an image in the dashboard chat ("put my face at the
bottom"), upload it with `call_app_api`'s `files`; the bytes go straight to the
app and never pass through you:

```
call_app_api { method: "POST", path: "/api/assets",
               files: [{ field: "file", attachment: 1, filename: "face.jpg" }] }
```

`attachment` counts the images attached in this chat, newest first (1 = the
latest). Only the dashboard chat has `files`, and only for images (JPEG, PNG,
WebP, GIF, 5 MB each, up to 5 per call). A video or a sound has to be uploaded
by the user in the editor's Media sidebar.

Users upload in the editor's **Media** sidebar and click an item to put it in
the video at the playhead. That adds a clip on new lanes above the others,
drawn on top, with an id `media-<key>`: an `<img>` centred at up to 60% of the
frame (3 s), or a muted `<video>` filling the frame plus an `<audio>` of the
same file one lane up (the video's own length). When the user then asks to place it ("my face at the bottom", "logo in
the corner"), restyle that element; don't add a second copy.

Every clip is on screen only inside its window: it appears at `data-start`
and leaves `data-duration` seconds later. A `<video>` or `<audio>` clip plays
from its own beginning within that window, and scrubbing seeks it frame for
frame, so the preview shows the frame the render will. Give a video clip a
`data-duration` (shorter trims it, longer holds its last frame) so it counts
toward the composition's length.

## Product demos of a web app (screen-recording style)

When the user asks for a demo, walkthrough or "screen recording" of a web app
at a link, the video shows that app being used: a cursor moves like a hand to
a control and clicks it, drags an item onto a canvas, draws a connection or
types, the page changes, and the camera zooms to what matters.

Build it from **stills of the real app, one per state, captured in a real
browser**, never from an `<iframe>` of the link. The renderer cannot click
inside an iframe or rewind it, and most apps refuse to be framed at all
(`frame-ancestors`). A still per state, with the cursor and camera animated on
top by the app, renders the same every time and works for any page you can
open. Typing is real too: stills taken while the text went in.

**Plan 3 to 6 steps.** For each: the state the page is in, what to point the
viewer at (`focus`), and the one action that reaches the next state:

| Action | What the video shows | Step length |
|---|---|---|
| `click` | cursor travels, presses, ripple, the page changes | 3.5 s (at least 2) |
| `drag` | the item is picked up and its ghost follows the cursor to the drop | 3.4 s (at least 2.2) |
| `connect` | a line grows from one handle to the cursor and lands on the other | 3.4 s (at least 2.2) |
| `type` | camera on the field, cursor clicks in, the text goes in | 4.5 s (at least 2.5) |

The last step usually has no action: 2 to 3 s to look at the result.

**Make it from the link, in this app.** You need no browser of your own: the
app walks the page in a real browser on Clawnify's capture service.

1. **Look at the page.** `POST /api/demos/outline { url }` answers with
   `image_url` (a screenshot of the page) and `controls`: each visible control
   with its `text`, a `selector`, its `box`, and for controls with no text of
   their own (a node's handle) the `context` they sit in and a `within`
   selector for that container. Pass `wait_gone: "Loading"` if the page shows
   a loading message first.
2. **Plan 3 to 6 steps** from what the user wants shown, naming elements by
   what they say. To see where a step leads before committing to it, outline
   again with the steps so far: `{ url, steps: [...] }` returns the page those
   steps end on.
3. **Make it**: `POST /api/demos { name, url, steps, wait_gone? }`. The app
   captures every state for real, puts the stills in the Media library and
   answers with the composition (and `lint`, and `warnings` for any click
   target that matched several controls). Open it for the user at
   `/<composition id>`.

A step is `{ focus?, seconds?, <one action> }`. After a click the capture also
records what the app does about it (a menu opening, a modal fading in, a tab
sliding over) as a short video, played from the moment the cursor presses, so
the demo shows the app's own motion rather than a cut. Nothing to ask for: it
is on for every click, and a click that changes the screen at once simply has
none. Add `"motion": false` to a click step to skip it.

```json
[
  { "drag": { "from": { "text": "Prompt", "selector": "[draggable=true]" },
              "to": { "x": 700, "y": 560 } } },
  { "type": { "into": { "selector": "[contenteditable=true]",
                        "within": { "text": "PROMPT 2", "closest": ".react-flow__node" } },
              "text": "A neon city skyline at dusk, retro poster style" } },
  { "connect": { "from": { "selector": ".react-flow__handle-right",
                           "within": { "text": "PROMPT 2", "closest": ".group.flow-node" } },
                 "to": { "selector": "[data-handleid=\"prompt\"]" } } },
  { "focus": { "text": "Outputs" }, "click": { "text": "Outputs" } },
  {}
]
```

A locator is `text` (the smallest visible element containing it; for a click
or a drag, controls win), `selector`, or both, plus `closest` to grow the match
to an ancestor such as its card and `within` to search only inside another
locator's match. A drop target can be a page point `{ "x", "y" }`. `seconds`
defaults to the action's length above. The browser is signed out and starts
fresh each time, so demo and claim workspaces work, and pages behind a login
do not.

**The page is not changed.** Unless you pass `allow_writes: true`, the
browser's save requests are blocked: the page changes on screen and nothing is
stored. Keep that default for any link that is someone's real workspace (a
claim link opens a prospect's real apps), so the demo leaves nothing behind.
Pass `allow_writes: true` only for disposable data, such as a public demo
workspace, and only when a step's result shows up after the server answers
(the response's `warnings` say how many requests were blocked).

**Never click** anything that commits, buys, sends, deletes, signs in or
claims (a "Claim this workspace" or "Use this app" button, a checkout, a send
button): the video should show the product, and some of those act for real.

**Refresh a demo** after the app changed: `POST /api/demos { composition_id }`
captures it again from the steps it was made with (kept inside the
composition) and swaps in the new stills, and nothing else: its layout, clip,
titles, look and timing stay as they are. With as many steps as before, each
keeps its start and length; with a different number they run on from the
first one's start.

**Layouts are shortcuts.** For a new demo, `layout` builds a common shape in
one go, so you don't hand-write it:

- `{ "kind": "split", "demo": "top", "clip": "<video asset key>" }`: the demo
  in the top half, the clip (a talking head) in the bottom half; `"demo":
  "bottom"` swaps them. Use with `fit: "cover"` to fill each half.
- `{ "kind": "pip", "clip": "<video asset key>", "corner": "bottom-right" }`:
  the demo full frame, the clip in a round bubble.
- Optional `position` (`"50% 40%"`) moves the clip's crop, e.g. to keep a face
  in frame.

The clip plays muted with its sound on a separate `<audio>` (HyperFrames'
rule), for its own length, and unless the steps carry `seconds` they are spread
over that length. After it is made, the composition is ordinary HTML: move or
resize anything, and nothing snaps back. Layout and look options sent with a
`composition_id` are ignored (the response says so).

**Already have stills?** (taken by hand: viewport 1600×900 at scale 2, boxes as
`{x,y,w,h}` page pixels.) Upload each with a multipart `POST /api/assets`
(field `file`), then build the video from them:

`POST /api/compositions/screen-demo`:

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

A step's action is one of `click: box`, `drag: { from: box, to: box }`,
`connect: { from: box, to: box }` or `type: { box, frames: [asset keys] }`.

Optional: `composition_id` (swap these stills into that video, keeping its
layout and everything else),
`page` (the capture viewport, default 1600×900), `frame` (the video size,
default 1920×1080), `accent` (the click ripple and connection line as `r,g,b`,
use the brand's). By default the app fills the video edge to edge, with
nothing around it. Two looks are off unless the user asks for them:
`floating: true` shows the app as a floating window (rounded corners, a
shadow, `background` around it), and `tilt: true` opens with the app tilting
in from 3D and closes with it tilting away.
It answers like a create, with `lint`; a bad step answers 400 with `problems`.

The result is an ordinary composition: one `<img class="clip demo-step">` per
step (plus one per typed still, and a `<video class="clip demo-motion">` per
click that had motion), and a script that turns each step's
`data-start`, focus and action boxes into the camera, cursor and action. So moving or trimming a step on
the timeline moves its motion with it. A click's motion video is a clip of its
own; the editor moves it with its step, and when you move a step in the HTML,
move its motion clip too, so it still starts as the cursor presses.
Leave that script as it is; change the look around it.

A rebuild (`composition_id`) regenerates the whole composition from the
request, so anything added by hand since (a title, a caption, a moved step) is
replaced. For a demo that will be captured again, put what should survive in
the request (`background`, `accent`, the steps' `seconds`), and add titles or
captions only to a demo you will not rebuild.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/compositions` | List compositions |
| GET  | `/api/compositions/{id}` | Get one (includes `html` and `lint`) |
| POST | `/api/compositions` | Create `{ name, description?, html?, fps? }` → the row with `lint` |
| POST | `/api/demos/outline` | A page's screenshot and visible controls, after optional steps (plan a demo) |
| POST | `/api/demos` | Make a product demo of a link, or refresh one (`composition_id`) |
| POST | `/api/compositions/screen-demo` | Build a product demo from stills you already have |
| PUT  | `/api/compositions/{id}` | Update any of `name/description/html/fps` → the row with `lint` |
| DELETE | `/api/compositions/{id}` | Delete |
| GET  | `/api/assets` | List uploaded media |
| POST | `/api/renders` | Export an MP4 `{ composition_id }` (only when a file is asked for) → returns the job at once |
| GET  | `/api/renders/{id}` | One export: poll it until `status` is `completed` or `failed` |
| GET  | `/api/renders` | List exports, newest first: `?composition_id=`, `?limit=` (default 50, max 100), `?before=<id>` for older |

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

Two HyperFrames rules are never reported, because their fix (move a scene into
a separate sub-composition file) cannot be made in a one-document composition:
a track with many clips, and a scene wrapper with its own inner layout
(`<div id="s1" class="clip"><div id="s1i">…`). Both render correctly. Do not
add `data-composition-id` to a scene to silence anything: it changes how the
scene's children are timed.

## Exporting (only when a file is asked for)

Rendering makes an MP4 file. It takes from a minute to several and is metered, so do it
only when the user asks for a file: to download it, post it, send it or attach
it. "Make me a video" or "change the title" never needs a render; "send me the
video" or "export it" does.

`POST /api/renders { composition_id }` answers at once with the job,
`status: "rendering"` (202). The render runs in the background: a few seconds
of video take about a minute, a 90-second video about four minutes. Do not wait on
one request, and do not poll in a tight loop: each check is a call you pay
for. Check `GET /api/renders/{id}` first after about as many seconds as the
video is long, then every 30 seconds, until `status` is
`completed` (share its `output_url`) or `failed` (read `error`, fix, export
again). While rendering, `phase: "queued"` means it waits for the org's other
renders. Nothing is lost if you stop polling: the next look (yours, the
editor's, the export list's) finishes it. In the app this is the **Export**
button.

## How rendering works (so you can reason about failures)

`POST /api/renders` ships your composition HTML + referenced assets to
Clawnify's managed render service, which runs `hyperframes render` in the
background; when it is done, the next look copies the MP4 into the app. The app itself does no rendering — it's a thin client. Failures usually
mean: a malformed composition (missing `data-composition-id`/dimensions, or a
timeline not registered on `window.__timelines`), or a referenced asset path
that doesn't match a real `key`. Read `error`, fix the HTML, render again.
