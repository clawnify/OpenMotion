import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  openChat,
  reportLocation,
  useChatContext,
  useHasChat,
  useHostChanges,
  useHostNavigate,
} from "@clawnify/app/client";
import { starterHtml } from "./starter";
import { FORMATS, formatOf, frameOf, ratioLabel, withFrame } from "../shared/format";
import { applyLayout, motionStart, type DemoLayout } from "../shared/screen-demo";
import { mediaHtml, mediaId, mediaKind, placeMedia } from "../shared/media";
import { Timeline, type TimelineEdit } from "./timeline";
import { compositionLength } from "../shared/length";
import type { Lint } from "../server/lint";
import { shiftTweenPositions } from "../shared/tween-shift";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import {
  ArrowLeft,
  Film,
  Plus,
  Upload,
  Trash2,
  Copy,
  Check,
  Loader2,
  Video,
  Image as ImageIcon,
  Type as TypeIcon,
  Music,
  AlertCircle,
  TriangleAlert,
  X,
  ChevronDown,
  Sparkles,
  Download,
} from "lucide-react";
import {
  Command,
  CommandGroup,
  CommandItem,
  ConfirmDialog,
  EmptyState,
  Popover,
  PopoverContent,
  PopoverTrigger,
  btnDanger,
  btnGhost,
  btnIcon,
  btnPrimary,
  btnSecondary,
  btnStatus,
  card,
  chip,
  stretch,
} from "./ui";

// ── types ────────────────────────────────────────────────────────────

interface Composition {
  id: string;
  name: string;
  description: string;
  html: string;
  fps: number;
  updated_at: string;
  /** What HyperFrames' linter says, on a single composition only (server/lint.ts). */
  lint?: Lint | null;
}

interface Asset {
  id: string;
  key: string;
  name: string;
  content_type: string;
  size: number;
  /** Seconds, for video and audio, when it was measured at upload. */
  duration?: number | null;
}

interface RenderJob {
  id: number;
  composition_id: string;
  status: "rendering" | "completed" | "failed";
  output_url: string | null;
  error: string | null;
  /** The media-library asset this render produced. */
  asset_id: string | null;
  created_at: string;
  /** While rendering: waiting behind the org's other renders, or running. */
  phase?: "queued" | "running";
}

// ── api ──────────────────────────────────────────────────────────────

async function errText(r: Response): Promise<string> {
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  return j.error || r.statusText;
}

const api = {
  async get<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(await errText(r));
    return r.json();
  },
  async send<T>(method: string, url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(await errText(r));
    return r.json();
  },
};

// ── app ──────────────────────────────────────────────────────────────

type Tab = "compose" | "timeline";

// Minimal history-based router: `/` = gallery, `/<id>` = editor for that id.
function useRouter() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, "", to);
    setPath(to);
  }, []);
  // Inside Clawnify: tell the dashboard where we are (so a reload or a shared
  // link restores this view), and let its chat open a video it just made
  // through this router instead of reloading the whole app.
  useEffect(() => reportLocation(path), [path]);
  useHostNavigate((to) => navigate(new URL(to, window.location.origin).pathname));
  return { path, navigate };
}

export function App() {
  const { path, navigate } = useRouter();
  // "/" → gallery; "/<id>" → composition editor.
  const id = decodeURIComponent(path.replace(/^\/+|\/+$/g, ""));

  return (
    <div className="h-dvh flex flex-col text-foreground">
      {/* Brand row: the app icon is the identity object, and the accent hue
          lives here (plus count badges and the focus ring) and nowhere else. */}
      <header className="flex items-center gap-2 px-5 h-14 border-b border-border bg-surface shrink-0">
        {id && (
          <button onClick={() => navigate("/")} className={`${btnGhost} -ml-2`}>
            <ArrowLeft className="w-4 h-4" /> Videos
          </button>
        )}
        <span className="grid place-items-center w-7 h-7 rounded-sm bg-accent text-on-accent shrink-0">
          <Film className="w-4 h-4" />
        </span>
        <span className="text-heading-3">OpenMotion</span>
        <span className="text-fine text-faint hidden sm:inline">motion graphics as code</span>
        {/* The editor portals its actions (issues, Ask AI, export) in here, so
            they ride the top bar while their state stays in the editor. Empty
            on the gallery. */}
        <div id="ove-topbar-actions" className="ml-auto flex items-center gap-2" />
      </header>

      {id ? (
        <EditorRoute id={id} navigate={navigate} />
      ) : (
        <Gallery navigate={navigate} />
      )}
    </div>
  );
}

// ── gallery ──────────────────────────────────────────────────────────

function fmtDate(s: string): string {
  // SQLite datetime('now') is space-separated UTC; normalise for Date().
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Gallery({ navigate }: { navigate: (to: string) => void }) {
  const [comps, setComps] = useState<Composition[] | null>(null);
  const [creating, setCreating] = useState(false);
  const hasChat = useHasChat();

  const load = useCallback(() => {
    api.get<Composition[]>("/api/compositions").then(setComps).catch(() => setComps([]));
  }, []);
  useEffect(load, [load]);
  // The agent made or changed a video from the chat: show it without a reload.
  useHostChanges(load);
  useChatContext({ label: "Videos" });

  async function newVideo(shape: Shape) {
    setCreating(true);
    try {
      const c = await api.send<Composition>("POST", "/api/compositions", {
        // Name it after what is actually on screen. Three things called
        // "Untitled" tell you nothing; this agrees with the thumbnail and says
        // what kind of object you just got.
        name: "Product launch title card",
        html: starterHtml(shape.width, shape.height),
      });
      navigate(`/${c.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Toolbar grammar: identity left, the one solid action right. */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-heading-1">
              Your videos
              {comps && comps.length > 0 && (
                <span className="ml-2 text-data text-muted tabular-nums">{comps.length}</span>
              )}
            </h1>
            <p className="text-body-sm text-muted mt-0.5">
              Graphics you make from scratch: titles, intros, lower thirds. Built on a timeline,
              rendered to MP4.
            </p>
          </div>
          {comps && comps.length > 0 && (
            <ShapeMenu align="end" onPick={newVideo}>
              <button disabled={creating} className={`${hasChat ? btnSecondary : btnPrimary} shrink-0`}>
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                New video
              </button>
            </ShapeMenu>
          )}
        </div>

        {hasChat && <DescribeVideo />}

        {comps === null ? (
          /* Loading is the shape of the answer, never a spinner. */
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className={`${card} overflow-hidden`}>
                <div className="aspect-video bg-surface-sunken animate-pulse" />
                <div className="px-4 py-3 space-y-2">
                  <div className="h-3 w-1/2 rounded-full bg-surface-sunken animate-pulse" />
                  <div className="h-2.5 w-1/3 rounded-full bg-surface-sunken animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : comps.length === 0 ? (
          <EmptyState
            icon={<Video className="w-8 h-8" />}
            title="No videos yet"
            body={
              hasChat
                ? "Describe one above, or start from a working title card and change the words."
                : "Start from a working title card and change the words."
            }
            action={
              <ShapeMenu onPick={newVideo}>
                <button disabled={creating} className={hasChat ? btnSecondary : btnPrimary}>
                  <Plus className="w-4 h-4" /> New video
                </button>
              </ShapeMenu>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {comps.map((c) => (
              <button
                key={c.id}
                onClick={() => navigate(`/${c.id}`)}
                className={`${card} group text-left overflow-hidden hover:bg-surface-sunken`}
              >
                <div className="aspect-video bg-black overflow-hidden">
                  <iframe
                    src={`/api/compositions/${c.id}/preview?seek=${posterTime(c.html)}`}
                    className="w-full h-full pointer-events-none"
                    scrolling="no"
                    tabIndex={-1}
                    title={c.name}
                  />
                </div>
                <div className="px-4 py-3">
                  <div className="truncate text-body-sm font-medium">{c.name}</div>
                  <div className="text-fine text-faint mt-0.5">Edited {fmtDate(c.updated_at)}</div>
                </div>
              </button>
            ))}
          </div>
        )}

      </div>
    </main>
  );
}

type Shape = (typeof FORMATS)[number];

/**
 * Picks a video's format: the shape a new video starts in, or, from the
 * editor, the one an existing video changes to. `chosen` marks the current one.
 */
function ShapeMenu({
  align,
  chosen,
  onPick,
  children,
}: {
  align?: "start" | "end";
  chosen?: string;
  onPick: (shape: Shape) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align={align}>
        <Command label="Shape">
          {FORMATS.map((o) => (
            <CommandItem
              key={o.id}
              value={o.id}
              onSelect={() => {
                setOpen(false);
                onPick(o);
              }}
            >
              <ShapeGlyph width={o.width} height={o.height} />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{o.name}</span>
                <span className="block truncate text-fine text-faint">{o.hint}</span>
              </span>
              <span className="text-fine text-muted tabular-nums">{o.ratio}</span>
              <Check className={`w-4 h-4 shrink-0 ${o.id === chosen ? "" : "invisible"}`} aria-hidden />
            </CommandItem>
          ))}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

const LAYOUTS = [
  { id: "full", name: "Full frame", hint: "The demo fills the video" },
  { id: "top", name: "Demo on top, clip below", hint: "A talking head under the demo" },
  { id: "bottom", name: "Clip on top, demo below", hint: "A talking head over the demo" },
  { id: "pip", name: "Clip in a bubble", hint: "The demo full, the clip in a corner" },
] as const;
type LayoutId = (typeof LAYOUTS)[number]["id"];

/** Which layout a demo is in now, read from its HTML. */
function currentLayout(html: string): LayoutId {
  const area = /<div id="demo-area"[^>]*top:([^;]+);/.exec(html);
  // "0", "0px" (demos made before splits were percentages) or "50%".
  if (area) return parseFloat(area[1]) === 0 ? "top" : "bottom";
  if (/<video id="clip"[^>]*\s+style="[^"]*border-radius:50%/.test(html)) return "pip";
  return "full";
}

/** A video's length, from the upload record or from the file itself. */
async function clipSeconds(a: Asset): Promise<number> {
  if (a.duration && a.duration > 0) return a.duration;
  return new Promise((done) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : 0);
    v.onerror = () => done(0);
    v.src = `/api/uploads/${a.key}`;
  });
}

/**
 * Picks a layout for a demo, then, for one with a clip, the clip from the
 * Media library. Applying it is a one-off: the result is ordinary HTML.
 */
function LayoutMenu({ current, onPick, children }: { current: LayoutId; onPick: (l: DemoLayout) => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<LayoutId | null>(null);
  const [videos, setVideos] = useState<Asset[] | null>(null);
  useEffect(() => {
    if (!open) return setPending(null);
    api.get<Asset[]>("/api/assets").then((all) => setVideos(all.filter((a) => a.content_type.startsWith("video/"))));
  }, [open]);

  async function choose(id: LayoutId, clip?: Asset) {
    if (id === "full") return finish({ kind: "full" });
    if (!clip) return setPending(id);
    const seconds = await clipSeconds(clip);
    const src = `assets/${clip.key}`;
    finish(id === "pip" ? { kind: "pip", clip: src, seconds } : { kind: "split", demo: id === "top" ? "top" : "bottom", clip: src, seconds });
  }
  function finish(l: DemoLayout) {
    setOpen(false);
    onPick(l);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start">
        {pending === null ? (
          <Command label="Layout">
            {LAYOUTS.map((o) => (
              <CommandItem key={o.id} value={o.id} onSelect={() => choose(o.id)}>
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{o.name}</span>
                  <span className="block truncate text-fine text-faint">{o.hint}</span>
                </span>
                <Check className={`w-4 h-4 shrink-0 ${o.id === current ? "" : "invisible"}`} aria-hidden />
              </CommandItem>
            ))}
          </Command>
        ) : videos && videos.length === 0 ? (
          <p className="p-3 text-body-sm text-muted max-w-64">Upload a video in Media first, then pick it here.</p>
        ) : (
          <Command label="Clip">
            <CommandGroup heading="Pick the clip">
              {(videos ?? []).map((a) => (
                <CommandItem key={a.id} value={a.key} onSelect={() => choose(pending, a)}>
                  <Video className="w-4 h-4 shrink-0 text-muted" />
                  <span className="flex-1 min-w-0 truncate">{a.name}</span>
                  {a.duration ? <span className="text-fine text-muted tabular-nums">{a.duration.toFixed(1)}s</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The frame drawn to scale, so the three options read at a glance. */
function ShapeGlyph({ width, height }: { width: number; height: number }) {
  const s = 16 / Math.max(width, height);
  return (
    <span className="w-5 h-5 shrink-0 grid place-items-center" aria-hidden>
      <span
        className="border-2 border-muted"
        style={{ width: Math.round(width * s), height: Math.round(height * s) }}
      />
    </span>
  );
}

/**
 * Where a video starts from words. The prompt goes to the agent's chat as a
 * DRAFT: the user reads it there and presses send, so nothing runs on their
 * behalf from a box in someone else's app. Rendered only when there is a chat
 * to open (inside Clawnify); standalone the gallery keeps its button.
 */
function DescribeVideo() {
  const [text, setText] = useState("");
  const brief = text.trim();

  function ask() {
    if (!brief) return;
    if (openChat(`Make a new video in OpenMotion: ${brief}`)) setText("");
  }

  return (
    <div className="mb-6">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            ask();
          }
        }}
        rows={2}
        maxLength={1800}
        aria-label="Describe a video"
        placeholder="Describe a video: what it is for, how long, vertical or landscape, the mood. Or paste a link to a web app and say what the demo should show."
        className="field resize-none"
      />
      <div className="flex items-center justify-between gap-3 mt-2">
        <span className="text-fine text-faint">Opens the chat with this as a draft. Nothing is sent until you press send.</span>
        <button onClick={ask} disabled={!brief} className={`${btnPrimary} shrink-0`}>
          <Sparkles className="w-4 h-4" /> Ask AI
        </button>
      </div>
    </div>
  );
}

// ── editor route (fetch one composition by id from the URL) ───────────

function EditorRoute({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  // undefined = loading, null = not found, Composition = loaded.
  const [comp, setComp] = useState<Composition | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setComp(undefined);
    api
      .get<Composition>(`/api/compositions/${id}`)
      .then((c) => alive && setComp(c))
      .catch(() => alive && setComp(null));
    return () => {
      alive = false;
    };
  }, [id]);

  if (comp === undefined) {
    return <div className="flex-1 grid place-items-center text-body-sm text-faint">Loading…</div>;
  }
  if (comp === null) {
    return (
      <div className="flex-1 grid place-items-center">
        <EmptyState
          icon={<AlertCircle className="w-8 h-8" />}
          title="That video doesn’t exist"
          body="It may have been deleted, or the link is wrong."
          action={
            <button onClick={() => navigate("/")} className={btnSecondary}>
              <ArrowLeft className="w-4 h-4" /> Back to your videos
            </button>
          }
        />
      </div>
    );
  }
  return <Editor key={comp.id} comp={comp} navigate={navigate} />;
}

// ── editor ───────────────────────────────────────────────────────────

function Editor({
  comp,
  navigate,
}: {
  comp: Composition;
  navigate: (to: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("timeline");
  const [html, setHtml] = useState(comp.html);
  const [name, setName] = useState(comp.name);
  const [fps, setFps] = useState(comp.fps);
  const [previewKey, setPreviewKey] = useState(0);
  // Resizable layout, persisted per-seam across reloads.
  const vLayout = useDefaultLayout({
    id: "ove:editor-v:v2",
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const hLayout = useDefaultLayout({
    id: "ove:editor-h:v3",
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // What the server holds, as far as this editor knows. Local HTML that
  // differs from it is unsaved work the agent's changes must not overwrite.
  const saved = useRef({ name: comp.name, html: comp.html, fps: comp.fps });
  // The agent's version, held back while there is unsaved work.
  const [incoming, setIncoming] = useState<Composition | null>(null);
  // Bumped on every write the chat makes, so the panels refetch.
  const [changes, setChanges] = useState(0);
  const hasChat = useHasChat();
  // Undo: whole-composition snapshots, one per gesture or burst of typing.
  const history = useRef<{ past: string[]; future: string[] }>({ past: [], future: [] });
  const [, bumpHistory] = useState(0);
  // The HTML before the edit now being saved, recorded as one step once it is.
  const pendingBefore = useRef<string | null>(null);
  function remember(before: string) {
    const h = history.current;
    h.past.push(before);
    if (h.past.length > 100) h.past.shift();
    h.future = [];
    bumpHistory((n) => n + 1);
  }
  // The linter's verdict on the saved composition; every save answers with a new one.
  const [lint, setLint] = useState<Lint | null>(comp.lint ?? null);
  // Saves can overlap (a debounced edit, then Save), and their answers can land
  // out of order: only the latest one's verdict describes what is saved.
  const lintSeq = useRef(0);
  async function putAndLint(body: { name: string; html: string; fps: number }) {
    const seq = ++lintSeq.current;
    const row = await api.send<Composition>("PUT", `/api/compositions/${comp.id}`, body);
    if (seq === lintSeq.current) setLint(row.lint ?? null);
  }

  // The top bar's action slot lives in the app header (outside this component);
  // the editor renders its actions into it through a portal. Resolved after the
  // DOM is committed, before paint, so the buttons don't flash in a frame late.
  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTopbarSlot(document.getElementById("ove-topbar-actions"));
  }, []);

  // Selected clip (by index) for the right-side inspector.
  const [selectedClip, setSelectedClip] = useState<number | null>(null);

  // A video opens with nothing selected. Selecting a clip also loops the
  // preview over that clip's span, so an editor that pre-selected one (it used
  // to pick the biggest title, or the first clip when there was none) opened
  // on a video that played only its first few seconds.

  // Playhead state, kept in sync with the preview iframe's master clock.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [playing, setPlaying] = useState(false); // default paused
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(5);

  // Refs so the (stable) message handler can re-apply state after an iframe reload.
  const timeRef = useRef(0);
  const winRef = useRef<{ start: number; end: number | null } | null>(null);
  const restoreRef = useRef<number | null>(null);

  function post(msg: Record<string, unknown>) {
    iframeRef.current?.contentWindow?.postMessage({ target: "hf-preview", ...msg }, "*");
  }

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const m = e.data;
      if (!m || m.source !== "hf-preview") return;
      if (typeof m.duration === "number") setDuration(m.duration);
      if (m.type === "time" && typeof m.t === "number") {
        setTime(m.t);
        timeRef.current = m.t;
      }
      if (m.type === "select" && typeof m.index === "number") setSelectedClip(m.index); // clicked in the video
      if (m.type === "meta") {
        // iframe (re)loaded — re-apply the loop window and restore the playhead.
        const w = winRef.current;
        post({ type: "window", start: w ? w.start : 0, end: w ? w.end : null });
        if (restoreRef.current != null) {
          post({ type: "seek", t: restoreRef.current });
          restoreRef.current = null;
        }
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function seek(t: number) {
    setPlaying(false);
    setTime(t);
    post({ type: "seek", t });
  }
  function togglePlay() {
    const next = !playing;
    setPlaying(next);
    post({ type: next ? "play" : "pause" });
  }

  // The selected clip defines a loop window the preview loops within. Selecting
  // a clip only sets the window — it never moves the playhead (you clicked
  // something you can already see) and never auto-plays.
  const clips = parseClips(html).clips;
  const poster = posterTime(html);
  const selClip = selectedClip != null ? clips.find((c) => c.index === selectedClip) ?? null : null;

  // The chat knows which video is open, so "make the title slower" means this one.
  useChatContext({ label: "Video", record: { type: "composition", id: comp.id, label: name } });

  function adopt(next: Composition) {
    if (next.html !== html) remember(html); // the agent's change can be undone like any other
    saved.current = { name: next.name, html: next.html, fps: next.fps };
    setHtml(next.html);
    setName(next.name);
    setFps(next.fps);
    lintSeq.current++; // an in-flight save's verdict is older than this one
    setLint(next.lint ?? null);
    setIncoming(null);
    restoreRef.current = timeRef.current; // keep the playhead where it was
    setPreviewKey((k) => k + 1);
  }

  // The agent wrote through the chat. Take its version of this video unless
  // the user has unsaved work, in which case ask instead of overwriting it.
  useHostChanges(async (paths) => {
    setChanges((n) => n + 1);
    if (!paths.some((p) => p.startsWith(`/api/compositions/${comp.id}`))) return;
    const next = await api.get<Composition>(`/api/compositions/${comp.id}`).catch(() => null);
    if (!next) return;
    const s0 = saved.current;
    if (next.html === s0.html && next.name === s0.name && next.fps === s0.fps) return;
    const dirty = html !== s0.html || name !== s0.name || fps !== s0.fps;
    if (dirty) setIncoming(next);
    else adopt(next);
  });

  function askAI() {
    const words = selClip ? selClip.text.replace(/\n+/g, " ").slice(0, 80) || selClip.label : "";
    const about = selClip ? `, on the ${selClip.type} "${words}" (at ${selClip.start}s)` : "";
    openChat(`In the OpenMotion video "${name}"${about}: `);
  }

  function fixWithAI(found: Lint) {
    const list = found.findings.map((f) => `- ${f.message}`).join("\n");
    openChat(`In the OpenMotion video "${name}", fix what HyperFrames' linter reports:\n${list}`);
  }

  useEffect(() => {
    winRef.current = selClip ? { start: selClip.start, end: selClip.start + selClip.duration } : null;
    const w = winRef.current;
    post({ type: "window", start: w ? w.start : 0, end: w ? w.end : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClip]);

  // Keys: space plays/pauses, Delete removes the selected clip, Cmd/Ctrl-Z
  // undoes and Shift-Cmd/Ctrl-Z redoes (never while typing in a field). The
  // handler is registered once and reads the latest state through a ref, so a
  // key pressed right after a click acts on what was just selected.
  const keyActions = useRef({ togglePlay, deleteClip, step, selectedClip });
  keyActions.current = { togglePlay, deleteClip, step, selectedClip };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      const a = keyActions.current;
      if (e.code === "Space") {
        e.preventDefault();
        a.togglePlay();
      } else if ((e.key === "Delete" || e.key === "Backspace") && a.selectedClip != null) {
        e.preventDefault();
        a.deleteClip(a.selectedClip);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        a.step(e.shiftKey ? "redo" : "undo");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * Save `next` and reload the preview on it. The preview iframe renders the
   * SAVED composition (the harness is served by /api/compositions/:id/preview),
   * so it can only show an edit after the save. Debounced so typing stays
   * smooth; the playhead is restored afterwards so an edit never jumps the time.
   */
  function persist(next: string, delay = 350, playhead?: number) {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(async () => {
      const before = pendingBefore.current;
      pendingBefore.current = null;
      if (before !== null && before !== next) remember(before);
      setSaving(true);
      try {
        await putAndLint({ name, html: next, fps });
        saved.current = { name, html: next, fps };
      } finally {
        setSaving(false);
      }
      restoreRef.current = playhead ?? timeRef.current;
      setPreviewKey((k) => k + 1);
    }, delay);
  }

  /** An inspector edit. A burst of typing becomes one undo step. */
  function updateClip(index: number, patch: ClipPatch) {
    if (pendingBefore.current === null) pendingBefore.current = html;
    const next = applyClipPatch(html, index, patch);
    setHtml(next);
    persist(next);
  }

  /**
   * A timeline drag. The edit carries absolute values and is applied to the
   * HTML from when the drag began (this handler's closure), so live updates
   * never compound; the release saves once and records one undo step.
   */
  function onTimelineChange(id: string, edit: TimelineEdit, phase: "live" | "commit") {
    const patch: ClipPatch = {};
    if (edit.start !== undefined) patch.start = edit.start;
    if (edit.duration !== undefined) patch.duration = edit.duration;
    if (edit.lane !== undefined) patch.track = edit.lane;
    if (pendingBefore.current === null) pendingBefore.current = html;
    const next = applyClipPatch(html, Number(id), patch);
    setHtml(next);
    if (phase === "commit") persist(next, 0);
  }

  function deleteClip(index: number) {
    const next = removeClip(html, index);
    if (next === html) return;
    if (pendingBefore.current === null) pendingBefore.current = html;
    setSelectedClip(null);
    setHtml(next);
    persist(next, 0);
  }

  /**
   * A Media library item, added from the playhead on new lanes above the
   * others (shared/media.ts), drawn on top of everything, and selected so the
   * inspector shows it. One undo step.
   */
  function addMedia(a: Asset) {
    const kind = mediaKind(a.content_type);
    if (!kind) return;
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const root = doc.querySelector("[data-composition-id]");
      if (!root) return;
      const stated = parseFloat(root.getAttribute("data-duration") || "");
      const place = placeMedia({
        kind,
        seconds: a.duration,
        playhead: timeRef.current,
        fps,
        tracks: parseClips(html).tracks,
        length: stated > 0 ? stated : null,
      });
      const taken = new Set(Array.from(doc.querySelectorAll("[id]"), (el) => el.id));
      const tpl = doc.createElement("template");
      tpl.innerHTML = mediaHtml(kind, `assets/${a.key}`, mediaId(a.key, taken), place);
      // Last of the visible elements: on top of everything, scripts stay last.
      const script = Array.from(root.children).find((el) => el.tagName === "SCRIPT");
      for (const el of Array.from(tpl.content.children)) {
        root.insertBefore(el, script ?? null);
        root.insertBefore(doc.createTextNode("\n  "), script ?? null);
      }
      if (place.length) root.setAttribute("data-duration", String(place.length));
      const next = root.outerHTML;
      if (pendingBefore.current === null) pendingBefore.current = html;
      setHtml(next);
      // Back to the new clip's start once the preview reloads: selecting it
      // sets a loop window the old preview, still at the old length, clamps to
      // its end before then.
      persist(next, 0, place.start);
      // The visual (or the sound, for audio) is the first clip it added.
      const added = parseClips(next).clips.find((c) => c.track === place.track && c.start === place.start);
      setSelectedClip(added ? added.index : null);
      setTab("timeline");
    } catch {
      /* malformed HTML mid-edit: nothing to add to */
    }
  }

  function step(dir: "undo" | "redo") {
    const h = history.current;
    const to = dir === "undo" ? h.past.pop() : h.future.pop();
    if (to === undefined) return;
    (dir === "undo" ? h.future : h.past).push(html);
    bumpHistory((n) => n + 1);
    clearTimeout(reloadTimer.current);
    pendingBefore.current = null;
    setHtml(to);
    persist(to, 0);
    // persist() records pendingBefore; history was moved by hand above.
  }

  const frame = frameOf(html);
  const currentFormat = frame ? formatOf(frame.width, frame.height) : undefined;

  /**
   * Change the video's format. Only the canvas changes: a product demo fits
   * itself to it when it plays; anything else is free HTML whose layout can't
   * be moved mechanically, so the AI is asked to re-lay it out (a draft the
   * user sends). One undo step either way.
   */
  function changeFormat(f: Shape) {
    if (!frame || (frame.width === f.width && frame.height === f.height)) return;
    const from = currentFormat ? `${currentFormat.name} ${currentFormat.ratio}` : ratioLabel(frame.width, frame.height);
    if (pendingBefore.current === null) pendingBefore.current = html;
    const next = withFrame(html, f.width, f.height);
    setHtml(next);
    persist(next, 0);
    const fitsItself = /class="clip demo-step"/.test(next);
    if (!fitsItself && hasChat && parseClips(next).clips.length > 0) {
      openChat(
        `In the OpenMotion video "${name}": I changed its format from ${from} to ${f.name} ${f.ratio} ` +
          `(${f.width}×${f.height}). Re-lay out every element for the new frame so nothing is cut off ` +
          `or crowded; keep the words, timing and motion.`,
      );
    }
  }

  const isDemo = /class="clip demo-step"/.test(html);

  /** Put the demo in a layout, once (shared/screen-demo.ts applyLayout). One undo step. */
  function changeLayout(layout: DemoLayout) {
    const next = applyLayout(html, layout);
    if (!next || next === html) return;
    if (pendingBefore.current === null) pendingBefore.current = html;
    setSelectedClip(null);
    setHtml(next);
    persist(next, 0);
  }

  async function save() {
    setSaving(true);
    try {
      await putAndLint({ name, html, fps });
      if (saved.current.html !== html) remember(saved.current.html);
      saved.current = { name, html, fps };
      setIncoming(null);
      setPreviewKey((k) => k + 1); // reload iframe
      setTime(poster);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await api.send("DELETE", `/api/compositions/${comp.id}`);
    navigate("/");
  }

  return (
    <main className="flex-1 min-h-0 min-w-0 bg-background">
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${comp.name}”?`}
          body="The composition and its render history go with it. This cannot be undone."
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      {/* Editor actions ride the app's top bar (rendered in the header above). */}
      {topbarSlot &&
        createPortal(
          <>
            <LintMenu lint={lint} onFix={hasChat ? fixWithAI : undefined} />
            {hasChat && (
              <button onClick={askAI} className={btnSecondary}>
                <Sparkles className="w-4 h-4" /> Ask AI
              </button>
            )}
            <ExportMenu comp={{ ...comp, name }} changes={changes} />
          </>,
          topbarSlot,
        )}
      <Group
        orientation="vertical"
        defaultLayout={vLayout.defaultLayout}
        onLayoutChanged={vLayout.onLayoutChanged}
      >
        {/* preview (left) + clip inspector (right) — Remotion-style */}
        <Panel id="stage" defaultSize="68%" minSize="40%" className="min-h-0">
          <Group
            orientation="horizontal"
            defaultLayout={hLayout.defaultLayout}
            onLayoutChanged={hLayout.onLayoutChanged}
          >
            <Panel id="media" defaultSize="18%" minSize="12%" maxSize="32%" className="bg-surface min-w-0">
              <MediaSidebar changes={changes} onAdd={addMedia} />
            </Panel>

            <Separator className="ove-sep-x" />

            <Panel id="preview" defaultSize="58%" minSize="35%" className="min-w-0 p-5">
              {/* Preview stage: the harness scales + centers the composition,
                  letterboxing it inside this black stage (any panel shape). */}
              <div className="h-full w-full min-h-0 min-w-0 bg-black rounded-md overflow-hidden shadow-edge">
                <iframe
                  ref={iframeRef}
                  key={previewKey}
                  src={`/api/compositions/${comp.id}/preview?seek=${poster}`}
                  className="w-full h-full"
                  title="preview"
                  // Lets the composition's <audio> clips play when the user presses play.
                  allow="autoplay"
                />
              </div>
            </Panel>

            <Separator className="ove-sep-x" />

            <Panel id="inspector" defaultSize="24%" minSize="16%" maxSize="46%" className="bg-surface overflow-y-auto">
              {selClip ? (
                <Inspector
                  key={selClip.index}
                  clip={selClip}
                  onChange={(p) => updateClip(selClip.index, p)}
                  onClose={() => setSelectedClip(null)}
                />
              ) : (
                <div className="px-4 py-4 space-y-5">
                  {frame && (
                    <div>
                      <div className="text-label text-muted mb-1.5">Format</div>
                      <ShapeMenu chosen={currentFormat?.id} onPick={changeFormat}>
                        <button className={`${btnSecondary} w-full justify-between`}>
                          <span className="flex items-center gap-2 min-w-0">
                            <ShapeGlyph width={frame.width} height={frame.height} />
                            <span className="truncate">
                              {currentFormat ? currentFormat.name : "Custom"}{" "}
                              <span className="text-muted tabular-nums">{ratioLabel(frame.width, frame.height)}</span>
                            </span>
                          </span>
                          <ChevronDown className="w-4 h-4 shrink-0" />
                        </button>
                      </ShapeMenu>
                      <p className="text-fine text-faint mt-1.5 tabular-nums">
                        {frame.width} × {frame.height}
                      </p>
                    </div>
                  )}
                  {isDemo && (
                    <div>
                      <div className="text-label text-muted mb-1.5">Layout</div>
                      <LayoutMenu current={currentLayout(html)} onPick={changeLayout}>
                        <button className={`${btnSecondary} w-full justify-between`}>
                          <span className="truncate">{LAYOUTS.find((o) => o.id === currentLayout(html))?.name}</span>
                          <ChevronDown className="w-4 h-4 shrink-0" />
                        </button>
                      </LayoutMenu>
                      <p className="text-fine text-faint mt-1.5">A starting point: change anything after.</p>
                    </div>
                  )}
                  <div>
                    <div className="text-label text-muted mb-1">Inspector</div>
                    <p className="text-body-sm text-muted">
                      Select a clip, in the timeline or in the video, to edit it.
                    </p>
                  </div>
                </div>
              )}
            </Panel>
          </Group>
        </Panel>

        <Separator className="ove-sep-y" />

        {/* timeline + options */}
        <Panel id="dock" defaultSize="32%" minSize="16%" maxSize="60%" className="flex flex-col bg-background min-h-0">
          {/* view switcher: a segmented track, active segment raised white */}
          {incoming && (
            <div role="status" className="mx-5 mt-3 flex items-center gap-3 rounded-sm bg-warning-tint px-3 py-2 text-body-sm text-warning">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="flex-1 min-w-0">The agent changed this video while you had unsaved edits.</span>
              <button onClick={() => adopt(incoming)} className={btnSecondary}>
                Load its version
              </button>
              <button onClick={() => setIncoming(null)} className={btnGhost}>
                Keep mine
              </button>
            </div>
          )}
          <div className="px-5 pt-3 shrink-0 flex items-center gap-3">
            <div className="inline-flex items-center gap-0.5 rounded-full bg-surface-sunken p-0.5">
              {(["timeline", "compose"] as Tab[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  aria-pressed={tab === t}
                  className={`h-7 px-3 text-button capitalize rounded-sm ${
                    tab === t ? "bg-surface text-foreground shadow-raised" : "text-muted hover:text-foreground"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5 pt-3 min-h-0">
        {tab === "compose" && (
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="field flex-1"
                placeholder="Composition name"
                aria-label="Composition name"
              />
              <FpsPicker fps={fps} onChange={setFps} />
            </div>
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              spellCheck={false}
              aria-label="Composition HTML"
              className="field h-[40vh] font-mono text-fine"
            />
            <div className="flex items-center gap-2">
              <button onClick={save} disabled={saving} className={btnPrimary}>
                {saving ? "Saving…" : "Save & preview"}
              </button>
              <button onClick={() => setConfirmDelete(true)} className={btnDanger}>
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </div>
          </div>
        )}

        {tab === "timeline" && (
          <Timeline
            items={clips.map((c) => ({
              id: String(c.index),
              lane: c.track,
              start: c.start,
              duration: c.duration,
              label: c.label,
              fillClass: CLIP_FILL[c.type],
              barClass: CLIP_BAR[c.type],
              icon: clipIcon(c.type),
            }))}
            lanes={parseClips(html).tracks}
            duration={duration}
            time={time}
            playing={playing}
            fps={fps}
            selected={selectedClip == null ? null : String(selectedClip)}
            onSelect={(id) => setSelectedClip(id == null ? null : Number(id))}
            onSeek={seek}
            onTogglePlay={togglePlay}
            onChange={onTimelineChange}
            formatTime={(t) => fmtTC(t, fps)}
          />
        )}
          </div>
        </Panel>
      </Group>
    </main>
  );
}

// ── frame rate ───────────────────────────────────────────────────────

const FPS_OPTIONS = [
  { fps: 24, name: "Film", hint: "The cinematic cadence" },
  { fps: 30, name: "Standard", hint: "Social and web" },
  { fps: 60, name: "Smooth", hint: "Fast motion and UI demos" },
];

function FpsPicker({ fps, onChange }: { fps: number; onChange: (fps: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="field w-auto flex items-center gap-2 text-left" aria-label="Frame rate">
          <span className="tabular-nums">{fps} fps</span>
          <ChevronDown className="w-4 h-4 shrink-0 text-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <Command label="Frame rate">
          {FPS_OPTIONS.map((o) => (
            <CommandItem
              key={o.fps}
              value={String(o.fps)}
              onSelect={() => {
                setOpen(false);
                onChange(o.fps);
              }}
            >
              <span className="flex-1 min-w-0">
                <span className="block truncate">{o.name}</span>
                <span className="block truncate text-fine text-faint">{o.hint}</span>
              </span>
              <span className="text-fine text-muted tabular-nums">{o.fps} fps</span>
              <Check className={`w-4 h-4 shrink-0 ${o.fps === fps ? "" : "invisible"}`} />
            </CommandItem>
          ))}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── timeline ─────────────────────────────────────────────────────────

type ClipType = "video" | "image" | "text" | "audio";
interface Clip {
  index: number; // position among .clip elements — stable handle for editing
  start: number;
  duration: number;
  track: number;
  type: ClipType;
  label: string;
  /** The words, with each `<br>` as a line break. */
  text: string;
  /** Built from styled parts (spans, links): editing it as plain text would flatten them. */
  rich: boolean;
  color: string;
  fontSize: string;
  src: string;
}

/**
 * An element's words as they read on screen: whitespace collapsed as HTML
 * does, and each `<br>` kept as a line break. textContent drops `<br>`, which
 * fused "Type.<br>Motion." into "Type.Motion." in labels and prompts.
 */
function textOf(el: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n.nodeType === 3) out += (n.textContent || "").replace(/\s+/g, " ");
    else if (n.nodeName === "BR") out += "\n";
    else n.childNodes.forEach(walk);
  };
  el.childNodes.forEach(walk);
  return out
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** Parse HyperFrames `.clip` elements out of the composition HTML into tracks. */
function parseClips(html: string): { clips: Clip[]; tracks: number } {
  let clips: Clip[] = [];
  let tracks = 1;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    clips = Array.from(doc.querySelectorAll(".clip")).map((el, index) => {
      const tag = el.tagName.toLowerCase();
      const type: ClipType =
        tag === "video" ? "video" : tag === "img" ? "image" : tag === "audio" ? "audio" : "text";
      const text = textOf(el);
      const label = text.replace(/\n+/g, " ").slice(0, 28) || type[0].toUpperCase() + type.slice(1);
      return {
        index,
        start: parseFloat(el.getAttribute("data-start") || "0") || 0,
        duration: parseFloat(el.getAttribute("data-duration") || "0") || 0,
        track: parseInt(el.getAttribute("data-track-index") || "0", 10) || 0,
        type,
        label,
        text,
        rich: Array.from(el.children).some((c) => c.tagName !== "BR"),
        color: (el as HTMLElement).style?.color || "",
        fontSize: (el as HTMLElement).style?.fontSize || "",
        src: el.getAttribute("src") || "",
      };
    });
    tracks = Math.max(1, ...clips.map((c) => c.track + 1));
  } catch {
    /* malformed HTML mid-edit — show an empty timeline */
  }
  return { clips, tracks };
}

/**
 * A frame worth showing when nothing is playing.
 *
 * Compositions animate IN (`gsap.from({opacity: 0})`), so at t=0 every element
 * is still invisible and the composition renders as an empty frame. Landing the
 * gallery thumbnails and the editor on t=0 therefore showed a black rectangle
 * and made the app look broken on first open — the starter composition is meant
 * to be the thing that teaches you what this is, and it was showing nothing.
 *
 * Halfway through is the frame a video tool would pick for a poster: past the
 * entrances, before any outro.
 */
export function posterTime(html: string): number {
  const end = compositionLength(html) ?? 0;
  return end > 0 ? Math.round((end / 2) * 100) / 100 : 0;
}

export type ClipPatch = Partial<{
  text: string;
  color: string;
  fontSize: string;
  src: string;
  start: number;
  duration: number;
  track: number;
}>;

/** Apply an inspector edit to clip #index by round-tripping the HTML through the DOM. */
function applyClipPatch(html: string, index: number, patch: ClipPatch): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.querySelector("[data-composition-id]");
    const el = doc.querySelectorAll(".clip")[index] as HTMLElement | undefined;
    if (!root || !el) return html;
    // Only plain text (words and <br>s) is rewritten; one with styled parts
    // keeps them, so the inspector shows it read-only instead.
    if (patch.text !== undefined && !Array.from(el.children).some((c) => c.tagName !== "BR")) {
      el.textContent = "";
      patch.text.split("\n").forEach((line, i) => {
        if (i) el.appendChild(doc.createElement("br"));
        el.appendChild(doc.createTextNode(line));
      });
    }
    if (patch.color !== undefined) el.style.color = patch.color;
    if (patch.fontSize !== undefined) el.style.fontSize = patch.fontSize;
    if (patch.src !== undefined) el.setAttribute("src", patch.src);
    const oldStart = parseFloat(el.getAttribute("data-start") || "0") || 0;
    if (patch.start !== undefined) el.setAttribute("data-start", String(patch.start));
    if (patch.duration !== undefined) el.setAttribute("data-duration", String(patch.duration));
    if (patch.track !== undefined) el.setAttribute("data-track-index", String(patch.track));
    // A clip's entrance tween is positioned at an absolute composition time
    // equal to its start. When the start moves (a drag-move or a left-trim, or
    // an inspector start edit) the tween has to move with it, or the clip pops
    // in with its animation already over. Right-trim (duration only) leaves the
    // start alone and needs no shift. Only this clip's own id is touched.
    if (patch.start !== undefined && el.id) {
      const script = doc.querySelector("script:not([src])");
      if (script && script.textContent) {
        script.textContent = shiftTweenPositions(script.textContent, el.id, patch.start - oldStart);
      }
    }
    // A product demo step's click motion starts at the press, just before the
    // step ends, so it follows the step when the step moves or is trimmed.
    if ((patch.start !== undefined || patch.duration !== undefined) && el.classList.contains("demo-step") && el.id) {
      const motion = doc.getElementById(`${el.id}-motion`);
      if (motion) {
        const start = parseFloat(el.getAttribute("data-start") || "0") || 0;
        const seconds = parseFloat(el.getAttribute("data-duration") || "0") || 0;
        motion.setAttribute("data-start", String(motionStart(start, seconds)));
      }
    }
    // A stated length is where the render stops. Moving a clip's end past it
    // would cut the clip off in the MP4 while the timeline still shows it, so
    // the length follows the clip out. It never shrinks on its own: a hold
    // after the last clip can be deliberate.
    const length = parseFloat(root.getAttribute("data-duration") || "");
    if (length > 0 && (patch.start !== undefined || patch.duration !== undefined)) {
      const end = (parseFloat(el.getAttribute("data-start") || "0") || 0) + (parseFloat(el.getAttribute("data-duration") || "0") || 0);
      if (end > length) root.setAttribute("data-duration", String(Math.round(end * 100) / 100));
    }
    return root.outerHTML;
  } catch {
    return html;
  }
}

/** Remove clip #index. Tweens that targeted it find nothing and do nothing. */
function removeClip(html: string, index: number): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const root = doc.querySelector("[data-composition-id]");
    const el = doc.querySelectorAll(".clip")[index];
    if (!root || !el) return html;
    el.remove();
    return root.outerHTML;
  } catch {
    return html;
  }
}

// Category, not decoration: one hue per element kind, from the generated
// category palette, and the SAME four OpenVideo's timeline uses, so a video
// clip is the same colour in both apps.
//
// A clip is a TINT fill with same-hue text and a solid bar at its left edge,
// not a solid block: a timeline is mostly one kind of clip, and a wall of the
// solid role reads as a paint chart rather than a classification.
export const CLIP_BAR: Record<ClipType, string> = {
  video: "bg-track-video",
  image: "bg-track-image",
  text: "bg-track-text",
  audio: "bg-track-audio",
};
const CLIP_FILL: Record<ClipType, string> = {
  video: "bg-track-video-tint text-track-video",
  image: "bg-track-image-tint text-track-image",
  text: "bg-track-text-tint text-track-text",
  audio: "bg-track-audio-tint text-track-audio",
};
function clipIcon(type: ClipType) {
  const c = "w-3.5 h-3.5 shrink-0";
  if (type === "video") return <Video className={c} />;
  if (type === "image") return <ImageIcon className={c} />;
  if (type === "audio") return <Music className={c} />;
  return <TypeIcon className={c} />;
}
/** Frame timecode MM:SS.FF (Remotion-style). */
function fmtTC(t: number, fps: number) {
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  let f = Math.round((total - Math.floor(total)) * fps);
  if (f >= fps) f = fps - 1;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(m)}:${p(s)}.${p(f)}`;
}

// ── inspector ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-label text-muted mb-1">{label}</span>
      {children}
    </label>
  );
}

/** Section title inside a rail. Sentence case in `label`, never uppercase:
 *  the 11px tracked style belongs above a KPI number and nowhere else. */
function Zone({ children }: { children: React.ReactNode }) {
  return <div className="text-label text-muted">{children}</div>;
}

const inputCls = "field";

/** Right-side quick editor for the selected clip — fields depend on the clip type. */
function Inspector({
  clip,
  onChange,
  onClose,
}: {
  clip: Clip;
  onChange: (patch: ClipPatch) => void;
  onClose: () => void;
}) {
  const typeLabel = clip.type[0].toUpperCase() + clip.type.slice(1);
  const num = (v: string) => (v === "" ? 0 : parseFloat(v) || 0);

  return (
    <div className="overflow-hidden">
      {/* header zone */}
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-border">
        {/* Category bar: the cheapest visible classification there is, and it
            never competes with the text. */}
        <span className={`w-0.5 h-6 rounded-full shrink-0 ${CLIP_BAR[clip.type]}`} />
        <span className="text-muted">{clipIcon(clip.type)}</span>
        <div className="min-w-0">
          <div className="text-heading-3 truncate">{typeLabel}</div>
        </div>
        <span className={`ml-auto shrink-0 tabular-nums ${chip}`}>Track {clip.track + 1}</span>
        <button onClick={onClose} className={btnIcon} aria-label="Close inspector">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* content zone */}
      <div className="px-4 py-4 space-y-3 border-b border-border">
        <Zone>Content</Zone>
        {clip.type === "text" && (
          <>
            <Field label="Text">
              {clip.rich ? (
                <p className="text-body-sm text-muted whitespace-pre-line">
                  {clip.text}
                  <span className="block mt-1 text-fine text-faint">
                    Styled in parts. Change it in Compose, or ask the AI.
                  </span>
                </p>
              ) : (
                <textarea
                  className={`${inputCls} resize-none`}
                  rows={Math.min(4, Math.max(1, clip.text.split("\n").length))}
                  value={clip.text}
                  onChange={(e) => onChange({ text: e.target.value })}
                />
              )}
            </Field>
            <Field label="Color">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Text colour"
                  className="field w-8 shrink-0 p-1"
                  value={toHex(clip.color)}
                  onChange={(e) => onChange({ color: e.target.value })}
                />
                <input
                  className={inputCls}
                  value={clip.color}
                  onChange={(e) => onChange({ color: e.target.value })}
                  placeholder="#ffffff"
                />
              </div>
            </Field>
            <Field label="Font size">
              <input
                className={inputCls}
                value={clip.fontSize}
                onChange={(e) => onChange({ fontSize: e.target.value })}
                placeholder="96px"
              />
            </Field>
          </>
        )}

        {(clip.type === "image" || clip.type === "video" || clip.type === "audio") && (
          <Field label="Source">
            <input
              className={inputCls}
              value={clip.src}
              onChange={(e) => onChange({ src: e.target.value })}
              placeholder="assets/your-file"
            />
          </Field>
        )}
      </div>

      {/* timing zone */}
      <div className="px-4 py-4 space-y-3">
        <Zone>Timing</Zone>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Start (s)">
            <input
              type="number"
              step="0.1"
              className={`${inputCls} tabular-nums`}
              value={clip.start}
              onChange={(e) => onChange({ start: num(e.target.value) })}
            />
          </Field>
          <Field label="Dur (s)">
            <input
              type="number"
              step="0.1"
              className={`${inputCls} tabular-nums`}
              value={clip.duration}
              onChange={(e) => onChange({ duration: num(e.target.value) })}
            />
          </Field>
          <Field label="Track">
            <input
              type="number"
              min="1"
              className={`${inputCls} tabular-nums`}
              value={clip.track + 1}
              onChange={(e) => onChange({ track: Math.max(0, Math.round(num(e.target.value)) - 1) })}
            />
          </Field>
        </div>
      </div>
    </div>
  );
}

/** Best-effort convert a CSS color (hex or rgb) to #rrggbb for the color input. */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (m) {
    const h = (n: string) => Number(n).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }
  return "#ffffff";
}

// ── media ────────────────────────────────────────────────────────────

/** A file's length in seconds, read from its metadata; null for a still, or
 *  when it cannot be read in 3 s. Measured here because the upload streams the
 *  bytes away and the server never decodes media. */
function probeFile(file: File): Promise<number | null> {
  if (!/^(video|audio)\//.test(file.type)) return Promise.resolve(null);
  return new Promise((done) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
    const finish = (d: number | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      done(d);
    };
    const timer = setTimeout(() => finish(null), 3000);
    el.preload = "metadata";
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => finish(null);
    el.src = url;
  });
}

const fmtSeconds = (d: number) => (d >= 60 ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")}` : `${d.toFixed(1)} s`);

/**
 * The Media library beside the preview, as in OpenVideo: click an item to put
 * it in the video at the playhead. Files dropped anywhere on it upload.
 */
function MediaSidebar({ changes, onAdd }: { changes: number; onAdd: (a: Asset) => void }) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Asset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setAssets(await api.get<Asset[]>("/api/assets"));
  }
  useEffect(() => {
    load();
  }, [changes]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const probe = probeFile(f);
        const fd = new FormData();
        fd.append("file", f);
        const res = await fetch("/api/assets", { method: "POST", body: fd });
        if (!res.ok) continue;
        const row = (await res.json()) as Asset;
        // The length lands after the upload, so a slow probe never holds it up.
        const duration = await probe;
        if (duration) await api.send("PATCH", `/api/assets/${row.id}`, { duration });
      }
      await load();
    } finally {
      setUploading(false);
    }
  }

  async function del(id: string) {
    await api.send("DELETE", `/api/assets/${id}`);
    load();
  }

  /** Added at its real length: one stored without it (an older upload) is
   *  measured now and the library keeps the answer, as OpenVideo heals them. */
  async function add(a: Asset) {
    if (a.duration || !/^(video|audio)\//.test(a.content_type)) return onAdd(a);
    const seconds = await Promise.race([clipSeconds(a), new Promise<number>((done) => setTimeout(() => done(0), 5000))]);
    if (!seconds) return onAdd(a);
    const row = await api.send<Asset>("PATCH", `/api/assets/${a.id}`, { duration: seconds });
    setAssets((all) => all?.map((x) => (x.id === row.id ? row : x)) ?? all);
    onAdd(row);
  }

  function copy(key: string) {
    navigator.clipboard.writeText(`assets/${key}`);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  }

  const addable = (a: Asset) => mediaKind(a.content_type) !== null;
  // Row actions show on hover or keyboard focus, and always on touch screens.
  const reveal = "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

  return (
    <div
      className={`h-full flex flex-col min-h-0 ${dragging ? "bg-surface-sunken" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        upload(e.dataTransfer.files);
      }}
    >
      <div className="px-4 pt-4 pb-2 shrink-0 flex items-center gap-2">
        <h2 className="flex-1 text-label text-muted">Media</h2>
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className={btnSecondary}>
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          Upload
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0">
        {assets?.length === 0 && (
          <EmptyState
            icon={<Film className="w-8 h-8" />}
            title="No media yet"
            body="Upload or drop a logo, a photo, a clip or a sound, then click it to put it in the video at the playhead."
          />
        )}
        <ul className="space-y-2">
          {assets?.map((a) => (
            <li key={a.id} className={`${card} group relative overflow-hidden`}>
              <button
                onClick={() => add(a)}
                disabled={!addable(a)}
                aria-label={`Add ${a.name} to the video`}
                title={addable(a) ? "Add to the video at the playhead" : "This kind of file can't go in a video"}
                className="block w-full text-left disabled:cursor-not-allowed"
              >
                <div className="relative h-20 bg-surface-sunken grid place-items-center overflow-hidden">
                  {a.content_type.startsWith("image/") ? (
                    <img src={`/api/uploads/${a.key}`} alt="" className="w-full h-full object-cover" />
                  ) : a.content_type.startsWith("video/") ? (
                    // Halfway in, as posterTime does: an export fades in, so its first frame is empty.
                    <video src={`/api/uploads/${a.key}#t=${a.duration ? (a.duration / 2).toFixed(1) : 0.1}`} preload="metadata" muted className="w-full h-full object-cover" />
                  ) : a.content_type.startsWith("audio/") ? (
                    <Music className="w-6 h-6 text-track-audio" />
                  ) : (
                    <Film className="w-6 h-6 text-faint" />
                  )}
                  {a.duration ? (
                    <span className="absolute bottom-1 right-1 rounded-xs bg-surface/90 px-1 text-fine tabular-nums text-foreground">
                      {fmtSeconds(a.duration)}
                    </span>
                  ) : null}
                </div>
                <div className="px-2 py-1.5 pr-16 text-body-sm truncate">{a.name}</div>
              </button>
              <div className="absolute right-1 bottom-0.5 flex items-center">
                <button onClick={() => copy(a.key)} className={`${btnIcon} ${reveal}`} aria-label={`Copy the path of ${a.name}`} title={`Copy assets/${a.key}`}>
                  {copied === a.key ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <button
                  onClick={() => setConfirmDel(a)}
                  className={`${btnIcon} ${reveal} hover:text-danger`}
                  aria-label={`Delete ${a.name}`}
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {confirmDel && (
        <ConfirmDialog
          title={`Delete “${confirmDel.name}”?`}
          body="Any composition that references this file will render without it."
          onConfirm={() => {
            del(confirmDel.id);
            setConfirmDel(null);
          }}
          onClose={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

// ── lint ─────────────────────────────────────────────────────────────

/** What will render wrong, before anyone exports. Shown only when there is
 *  something to say: a clean video gets no badge, not a green tick. */
function LintMenu({ lint, onFix }: { lint: Lint | null; onFix?: (lint: Lint) => void }) {
  const [open, setOpen] = useState(false);
  if (!lint || lint.findings.length === 0) return null;
  const total = lint.errors + lint.warnings;
  const more = total - lint.findings.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={lint.errors ? btnStatus.danger : btnStatus.warning}>
          <TriangleAlert className="w-4 h-4" />
          {total === 1 ? "1 issue" : `${total} issues`}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" wide>
        <div className="max-h-96 overflow-y-auto p-3 space-y-3">
          <p className="text-body-sm text-muted">These will look wrong in the exported video.</p>
          <ul className="space-y-3">
            {lint.findings.map((f, i) => (
              <li key={i} className="flex gap-2">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${f.severity === "error" ? "bg-danger-solid" : "bg-warning-solid"}`}
                />
                <div className="min-w-0 [overflow-wrap:anywhere]">
                  <p className="text-body-sm text-foreground">
                    <span className="sr-only">{f.severity === "error" ? "Error: " : "Warning: "}</span>
                    {f.message}
                  </p>
                  {f.fix && <p className="mt-1 text-fine text-muted">{f.fix}</p>}
                  {f.line && <p className="mt-1 text-fine text-faint">Line {f.line}</p>}
                </div>
              </li>
            ))}
          </ul>
          {more > 0 && <p className="text-fine text-faint">And {more} more.</p>}
        </div>
        {onFix && (
          <div className="border-t border-border p-2">
            <button
              onClick={() => {
                setOpen(false);
                onFix(lint);
              }}
              className={`${btnSecondary} ${stretch}`}
            >
              <Sparkles className="w-4 h-4" /> Ask AI to fix
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── export ───────────────────────────────────────────────────────────

/**
 * Export is the only place a video is rendered. The preview is the video
 * frame for frame, so making or changing one never needs a render; a file is
 * made only when someone wants one, and it downloads as soon as it is ready.
 * Each export also lands in the media library, so it can be reused as footage.
 *
 * The render runs in the background on the server, so a long video, a closed
 * tab or a reload loses nothing: reopening the video picks the export up again.
 * Only an export started in this tab downloads by itself when it is done.
 */
function ExportMenu({ comp, changes }: { comp: Composition; changes: number }) {
  const [open, setOpen] = useState(false);
  // null = not loaded yet: never claim "no exports" before we know.
  const [jobs, setJobs] = useState<RenderJob[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState("");
  const startedHere = useRef<number | null>(null);

  async function load() {
    const list = await api
      .get<RenderJob[]>(`/api/renders?composition_id=${encodeURIComponent(comp.id)}`)
      .catch(() => null);
    if (list) setJobs(list);
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comp.id, changes]);

  const pending = (jobs ?? []).find((j) => j.status === "rendering");

  // Follow the export in progress until it lands. Each look also finishes it
  // on the server (copies the file, adds it to the media library).
  useEffect(() => {
    if (!pending) return;
    const id = pending.id;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(async () => {
      const j = await api.get<RenderJob>(`/api/renders/${id}`).catch(() => null);
      if (!j) return;
      setJobs((all) => (all ? all.map((x) => (x.id === j.id ? j : x)) : all));
      if (j.status === "rendering") return;
      if (j.status === "failed") setErr(j.error || "The export failed.");
      if (startedHere.current === j.id) {
        startedHere.current = null;
        if (j.status === "completed") download(j);
      }
    }, 3000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  function download(job: RenderJob) {
    if (!job.output_url) return;
    const a = document.createElement("a");
    a.href = job.output_url;
    a.download = `${comp.name || "video"}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function exportMp4() {
    setOpen(false);
    setErr("");
    try {
      const job = await api.send<RenderJob>("POST", "/api/renders", { composition_id: comp.id });
      if (job.status === "failed") setErr(job.error || "The export failed.");
      else startedHere.current = job.id;
      setNow(Date.now());
      setJobs((all) => [job, ...(all ?? [])]);
    } catch (e) {
      setErr(String((e as Error).message || e));
    }
  }

  const done = (jobs ?? []).filter((j) => j.status === "completed" && j.output_url);
  const elapsed = pending ? Math.max(0, Math.floor((now - parseDbTime(pending.created_at)) / 1000)) : 0;

  return (
    <>
      {err && (
        <div role="alert" className="fixed bottom-4 right-4 z-50 flex max-w-md items-start gap-2 rounded-sm bg-danger-tint px-3 py-2 text-body-sm text-danger shadow-float">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1 min-w-0 [overflow-wrap:anywhere]" title={err}>
            Export failed: {err.length > 300 ? `${err.slice(0, 300)}…` : err}
          </span>
          <button onClick={() => setErr("")} className={btnIcon} aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      <Popover open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <PopoverTrigger asChild>
          <button disabled={!!pending} className={btnPrimary}>
            {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {pending
              ? `${pending.phase === "queued" ? "Waiting for other exports" : "Exporting"}… ${elapsed}s`
              : "Export"}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end">
          <Command label="Export">
            <CommandItem value="export-mp4" onSelect={exportMp4}>
              <Film className="w-4 h-4 shrink-0 text-muted" />
              <span className="flex-1 min-w-0">
                <span className="block truncate">Export MP4</span>
                <span className="block truncate text-fine text-faint">Downloads when it is ready, even after a reload</span>
              </span>
            </CommandItem>
            {jobs === null ? (
              <div className="px-2 py-2">
                <div className="h-3 w-2/3 rounded-full bg-surface-sunken animate-pulse" />
              </div>
            ) : (
              done.length > 0 && (
                <CommandGroup heading="Earlier exports">
                  {done.map((j) => (
                    <CommandItem key={j.id} value={`export-${j.id}`} onSelect={() => download(j)}>
                      <Download className="w-4 h-4 shrink-0 text-muted" />
                      <span className="flex-1 truncate tabular-nums">{fmtExportDate(j.created_at)}</span>
                      <span className="text-fine text-faint">Download</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            )}
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** A database time ("2026-10-05 12:00:00", UTC) as epoch milliseconds. */
function parseDbTime(s: string): number {
  return Date.parse(s.replace(" ", "T") + "Z");
}

function fmtExportDate(s: string): string {
  const d = new Date(parseDbTime(s));
  return isNaN(d.getTime())
    ? s
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
