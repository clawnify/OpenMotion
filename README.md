# OpenMotion

[![Deploy with Clawnify](https://app.clawnify.com/deploy-button.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenMotion)

Open-source **motion graphics as code**. A video is plain **HTML on a timeline**: write it yourself or have an AI agent write it, drop in your own media (logos, product demos), scrub the preview, and render to **MP4**. An open-source app template provided by [Clawnify.com](https://clawnify.com).

Built on **[HyperFrames](https://github.com/heygen-com/hyperframes)** (HTML to MP4, Apache-2.0), so there is no proprietary format and no per-seat license.

## Why

Agents are already good at writing motion graphics as code. Where it gets hard is the last ten percent: a title a little too low, one transition too many. OpenMotion keeps every video as readable HTML with a visual timeline on top, so a person can fix what the agent made without starting the prompt over.

## Features

- **Describe a video**: inside Clawnify, write what you want (what it is for, how long, vertical or landscape) and your AI agent builds it. **Ask AI** in the editor changes the video on screen, and the preview updates in place.
- **Timeline editor**: drag a clip to move it or onto another track, drag its edges to trim it, zoom in to the frame, and undo anything (Cmd/Ctrl-Z). Clips snap to the playhead and to each other, and every change is written back to the composition's timing attributes.
- **Catches what would render wrong**: every save runs HyperFrames' own linter, so a title a GSAP tween knocks off centre or a timeline that never plays shows up as an issue with its fix before you export, and **Ask AI to fix** hands the list to your agent.
- **Live preview**: one clock keeps the preview and the timeline in sync.
- **Bring your own media**: upload logos, photos, product clips and sound in the Media sidebar and click one to put it in the video at the playhead, or reference it by path (`assets/your-logo.png`) in the HTML.
- **Export when you need a file**: the preview is the video, so nothing renders until you export. Export makes a real MP4 in the background, downloads it when it is ready and keeps it in your media library. A long video or a closed tab loses nothing: reopen the video and the export picks up where it was.
- **Voiceovers and presenters**: turn a script into speech in one of your ElevenLabs voices, and a photo plus a voice clip into a video of that person speaking (fal.ai). Both land in your media library, run on your own accounts, and need the person's consent to animate them.
- **Music and sound effects**: a music bed made to the video's length and sound effects for its transitions and clicks, from a prompt, on your own ElevenLabs account. Every sound is measured (loudness in LUFS, and where it hits hardest), so an agent sets levels and timing from numbers.
- **Captions timed to the words**: every voiceover knows when each word is spoken, and a recording or video you upload can be transcribed, so captions land on the voice instead of being guessed.
- **Agent-ready**: a REST API (`/api/compositions`, `/api/assets`, `/api/renders`, `/api/speech`, `/api/music`, `/api/sound-effects`, `/api/presenters`) and an `agent.md`, so an agent can author and render videos on its own.

## How a composition works

A composition is one HTML fragment. The root carries the canvas size and the length in seconds; timed elements get `class="clip"` plus `data-start` / `data-duration` (seconds) / `data-track-index`, and animations are registered on a paused GSAP timeline:

```html
<div id="root" data-composition-id="promo" data-duration="6.5" data-width="1920" data-height="1080">
  <img src="assets/logo.png" class="clip" data-start="0" data-duration="6" data-track-index="0" />
  <h1 id="title" class="clip" data-start="0.5" data-duration="6" data-track-index="0"
      style="position:absolute;top:48%;left:50%;color:#fff;font-size:90px">
    Introducing Northwind
  </h1>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    gsap.set("#title", { xPercent: -50, yPercent: -50 }); // centre it with GSAP, not CSS
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: 40, duration: 1 }, 0.5);
    window.__timelines = { promo: tl };
  </script>
</div>
```

The editor reads those clips into the timeline automatically. The root's `data-duration` is where the render stops. On its own, HyperFrames would stop when the GSAP timeline ends (1.5 s here), so when it is missing OpenMotion fills it in from the last clip before rendering.

## Quickstart

```bash
pnpm install
pnpm dev        # UI on :5173, API on :8787, with a local SQLite database and storage
```

Hit **New video** and pick a shape (landscape, vertical or square) for a starter, edit the HTML in **Compose**, drop media in **Media**, scrub the timeline, and **Export** an MP4 when you need the file.

## Deploy

```bash
npx clawnify deploy
```

Rendering runs on Clawnify's managed render service, so a deployed app needs no local video toolchain.

Voiceovers, music, sound effects and presenters use your own ElevenLabs and fal.ai accounts. On Clawnify, connect them under Integrations. Anywhere else, set `ELEVENLABS_API_KEY` and `FAL_KEY`.

## Project layout

```
src/
  client/app.tsx     # UI: gallery, composition editor, timeline, media, renders
  client/ui.tsx      # shared control recipes (buttons, dialog, empty state)
  client/starter.ts  # the starter composition (video content, not app chrome)
  client/styles.css  # design tokens: palette, type scale, elevation
  server/            # Hono API: compositions (linted), assets, renders
agent.md             # how an AI agent authors and renders videos
```

## License

MIT for this app. HyperFrames is Apache-2.0.
