import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Layers, LoaderCircle, MessageSquare, RotateCcw, Send, SlidersHorizontal, Star, User } from "lucide-react";
import { api, steamPageUrl, thumb, workshopStub, ApiError, type LibraryItem, type Wallpaper, type WsComment, type WsCounts, type WsCreator } from "../api/client";
import { presetsOn, useStore } from "../store";
import { StatPills } from "./sidePills";
import { fmtCount } from "./sideFormat";
import { useMotion } from "./motion";
import { glideFlip, snapFlip, type FlipSnap } from "./flipGlide";
import { revealCard } from "../hooks/gridKeys";

// The item sidebars' Workshop community pieces (ItemSide.tsx, on both tabs): the creator, the
// favourite toggle, the comment thread and (Library) the item's counts (the backend: Web/WorkshopSocialOps.cs). Reading works signed out; favouriting and posting need the Steam sign-in: without it
// they become "Favourite on Steam" / "Comment on Steam", which open the item's page in the Steam app (store openOnSteam, the
// Steam page as the last resort: docs/decisions.md § "Offer two Workshop download modes, the Steam page the last resort"). A failed read is a quiet line in place, never a crash or a status-bar error. Steam limits its
// community site per IP (every call is spaced and stops during its cooldown — Helpers/SteamGate.cs), so the sidebar asks
// only for what the user looks at: the creator and the favourite once the sidebar has stayed on an item for SETTLE_MS (a
// run of arrow keys asks for nothing), the comments once their section scrolls into view, and each answer is kept for the
// session.

const SETTLE_MS = 350;
const PAGE = 10;
const creators = new Map<string, WsCreator>(); // per Workshop item
const favorites = new Map<string, boolean>(); // per Workshop item, signed in
// the favourite state as first read, per item for the session: what Steam's favourites count (read once and kept) already holds;
// a toggle here moves the shown count by one from it, a remount too
const favoritesCounted = new Map<string, boolean>();
const counts = new Map<string, WsCounts>(); // per Workshop item

function useSettled(key: string) {
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setSettled(key), SETTLE_MS); return () => clearTimeout(t); }, [key]);
  return settled === key;
}

// A Steam avatar from the media origin (thumb → /img; api/client.ts MEDIA): fades in once loaded, a person glyph until then
// or when it can't load.
export function Avatar({ src, size }: { src: string | null | undefined; size: number }) {
  const [ok, setOk] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const show = !!src && bad !== src;
  return (
    <span className="ws-avatar" style={{ width: size, height: size }} data-ws-avatar={show && ok === src ? "loaded" : "none"}>
      <User size={Math.round(size * 0.275) * 2} aria-hidden="true" />
      {show && <img src={thumb(src)} alt="" draggable={false} className={ok === src ? "on" : undefined}
        onLoad={() => setOk(src)} onError={() => setBad(src)} />}
    </span>
  );
}

// A sidebar row that takes the user to other wallpapers (the creator's, a scene's presets, a preset's base): a picture or
// glyph, a small heading over a name, and a chevron at its end. The whole row is the target: it lifts on hover and the
// chevron slides toward where it goes; no other icon (the row already says where a click goes, its aria-label in words). The
// name is selectable text, the way to copy it: a drag that selected some of it isn't a click. One control for all of them
// (index.css .ws-creator). Guard: probe-steam ws:creator, ws:presets, ws:presetBase
export function WsListRow({ lead, by, name, label, loading, disabled, rowClass = "ws-list-row", data, onGo }: {
  lead: ReactNode; by: string; name: string | null; label: string; loading?: boolean; disabled?: boolean;
  rowClass?: string; data: Record<`data-${string}`, string>; onGo: () => void;
}) {
  const click = (e: MouseEvent<HTMLButtonElement>) => {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return;
    onGo();
  };
  return (
    <div className={rowClass}>
      <button type="button" className={`ws-creator${loading ? " loading" : ""}`} aria-label={label} disabled={disabled} onClick={click} {...data}>
        {lead}
        <span className="ws-creator-text">
          <span className="ws-creator-by">{by}</span>
          <span className="ws-creator-name" data-ws-row-name>{name ?? "…"}</span>
        </span>
        <span className="ws-creator-go" data-ws-go aria-hidden="true"><ChevronRight size={16} /></span>
      </button>
    </div>
  );
}

// a glyph in an avatar's place (a list that isn't a person's)
const LeadGlyph = ({ icon }: { icon: ReactNode }) => <span className="ws-avatar" style={{ width: 30, height: 30 }}>{icon}</span>;

// The creator: their avatar and name; a click lists every Wallpaper Engine item they made in Browse (store setWsList —
// a source pill of its own, components/SourcePills.tsx), and `onListed` takes the user there from another tab (the Library
// sidebar). Guard: probe-steam ws:creator, ws:creatorSelect, lib:ws:creator
export function CreatorRow({ workshopId, authorId, onListed }: { workshopId: string; authorId: string | null | undefined; onListed?: () => void }) {
  const settled = useSettled(workshopId);
  const [c, setC] = useState<WsCreator | null>(() => creators.get(workshopId) ?? null);
  const [failed, setFailed] = useState(false);
  const setWsList = useStore((s) => s.setWsList);
  useEffect(() => {
    if (!settled || creators.has(workshopId)) return;
    let alive = true;
    api.workshopCreator(workshopId, authorId).then((r) => { creators.set(workshopId, r); if (alive) setC(r); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [settled, workshopId, authorId]);
  const id = c?.steamId ?? authorId ?? null;
  // nothing to say who made it (the creator unknown and unreadable): no row
  if (failed && !id) return null;
  const name = c?.name ?? (c || failed ? "Steam creator" : null);
  const go = () => {
    if (!id) return;
    setWsList({ kind: "creator", id, name: c?.name ?? null, avatar: c?.avatar ?? null });
    onListed?.();
  };
  return (
    <WsListRow rowClass="ws-creator-row" lead={<Avatar src={c?.avatar} size={30} />} by="Made by" name={name} loading={!name}
      label={`All their wallpapers, made by ${name ?? "…"}`}
      disabled={!id} data={{ "data-ws-creator": c ? "known" : failed ? "unknown" : "loading" }} onGo={go} />
  );
}

// A scene's presets (other people's saved settings of it, each its own Workshop item): a click lists every one made for this
// scene in Browse (store setWsList, a "Presets · <scene>" pill of its own, components/SourcePills.tsx), with the usual card
// actions, sorts and paging; `onListed` takes the user there from another tab. `scene` (its Browse result) lets its presets'
// "Uses" row bring its whole card back. Shown only while presets can play (store presetsOn); the caller shows it only for a
// scene that isn't itself a preset. Guard: probe-steam ws:presets, ws:presetsHidden, ws:presetsEmpty
export function PresetsRow({ workshopId, title, onListed, scene }: { workshopId: string; title: string | null; onListed?: () => void; scene?: Wallpaper }) {
  const on = useStore((s) => presetsOn(s.settings));
  const setWsList = useStore((s) => s.setWsList);
  if (!on) return null;
  return (
    <WsListRow lead={<LeadGlyph icon={<SlidersHorizontal size={16} aria-hidden="true" />} />} by="Presets" name="Made for this scene"
      label="All the presets made for this scene"
      data={{ "data-ws-presets": workshopId }}
      onGo={() => { setWsList({ kind: "presets", id: workshopId, name: title, scene: scene ?? null }); onListed?.(); }} />
  );
}

const bases = new Map<string, Base>(); // per preset, for the session
type Base = Awaited<ReturnType<typeof api.workshopBase>>;
// the library's copy of a base: its Workshop id, else the folder the backend found it in
const libraryBase = (items: LibraryItem[], b: Base) => items.find((x) => x.workshopId === b.baseId && !x.isPreset)
  ?? (b.libraryPath ? items.find((x) => x.videoPath === b.libraryPath || x.videoPath.startsWith(b.libraryPath + "/")) : undefined);

// A preset's base: "Uses" + the scene it plays (GET /workshop/base, asked once the sidebar settles and kept for the session). A
// click shows the base's card, never a Steam page: its Library card when the library has it (`onShowInLibrary`), else its
// Browse card — the shown list's own, the scene its presets list was opened from, or one made from what Steam said
// (store showBrowseItem; `onShowInBrowse` takes the user there from another tab). Nothing to say (not a preset, Steam
// unreachable): no row. A Library preset passes what its own file says (`local`: the base's id, title and library folder,
// GET /library): Steam isn't asked. Guard: probe-steam ws:presetBase, probe-sidebar lib:preset:uses
export function BaseRow({ presetId, local, onShowInLibrary, onShowInBrowse }: {
  presetId: string; local?: { baseId: string; title: string | null; path: string | null }; onShowInLibrary?: (path: string) => void; onShowInBrowse?: () => void;
}) {
  const settled = useSettled(presetId);
  const [fetched, setB] = useState<Base | null>(() => bases.get(presetId) ?? null);
  const b: Base | null = local ? { baseId: local.baseId, title: local.title, kind: "scene", libraryPath: local.path } : fetched;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (local || !settled || bases.has(presetId)) return;
    let alive = true;
    api.workshopBase(presetId).then((r) => { bases.set(presetId, r); if (alive) setB(r); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [local, settled, presetId]);
  const lib = useStore((s) => (b ? libraryBase(s.libraryItems, b) ?? null : null));
  if (failed) return null;
  const name = b ? b.title ?? "Its base scene" : null;
  const go = () => {
    if (!b) return;
    if (lib && onShowInLibrary) { onShowInLibrary(lib.videoPath); return; }
    const st = useStore.getState();
    const list = st.wsList?.kind === "presets" && st.wsList.id === b.baseId ? st.wsList.scene : null;
    const url = steamPageUrl(b.baseId);
    st.showBrowseItem(list ?? workshopStub(b.baseId, name ?? "", b.kind === "scene"));
    revealCard(`br-${st.wallpapers.find((x) => x.workshopId === b.baseId)?.pageUrl ?? url}`);
    onShowInBrowse?.();
  };
  return (
    <WsListRow lead={<LeadGlyph icon={<Layers size={16} aria-hidden="true" />} />} by="Uses" name={name} loading={!b}
      label={`Uses ${name ?? "…"}. ${lib ? "Show it in your library" : "Show its card"}`}
      disabled={!b} data={{ "data-ws-base": b ? "known" : "loading" }} onGo={go} />
  );
}

// The favourite: the favourites count pill is the toggle (docs/decisions.md § "One sidebar for an item, the same on both
// tabs"; state shows on the control that changes it, never twice): its star fills while the item is in the account's Steam
// favourites, a click toggles it and the count follows (Steam's own number moves the next time it's read); the new state's
// star pops once on a user change, never on mount (index.css .ico-pop). Without a usable sign-in a click opens the item's page
// in the Steam app (its tooltip says so); the backend then watches that item's favourite state there for a few minutes
// (Helpers/SteamFavoriteWatch.cs). `count` = Steam's favourites count (null: unknown, the star alone).
// Guard: probe-steam ws:favorite, ws:favoriteSteam
export function FavoritePill({ workshopId, count }: { workshopId: string; count: number | null | undefined }) {
  const settled = useSettled(workshopId);
  const [st, setSt] = useState<{ signedIn: boolean; favorited: boolean | null } | null>(() =>
    favorites.has(workshopId) ? { signedIn: true, favorited: favorites.get(workshopId)! } : null);
  // what Steam's count already holds: the state as first read (a later toggle moves the shown count by one)
  const [counted, setCounted] = useState<boolean | null>(() => favoritesCounted.get(workshopId) ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pops, setPops] = useState(0); // user changes: the star's key, so each one pops once
  useEffect(() => {
    if (!settled || favorites.has(workshopId)) return;
    let alive = true;
    api.workshopFavorite(workshopId).then((r) => {
      if (r.signedIn && r.favorited != null) { favorites.set(workshopId, r.favorited); favoritesCounted.set(workshopId, r.favorited); }
      if (alive) { setSt(r); setCounted(r.favorited ?? null); }
    }).catch(() => { if (alive) setSt({ signedIn: true, favorited: null }); });
    return () => { alive = false; };
  }, [settled, workshopId]);
  const on = st?.favorited === true;
  const signedOut = st?.signedIn === false;
  const openOnSteam = useStore((s) => s.openOnSteam);
  const toggle = async () => {
    // the backend watches the Steam app's favourites a few minutes after, so the Favourites list follows what the user does there
    if (signedOut) { void openOnSteam(workshopId, "favorite"); return; }
    if (!st?.signedIn || busy) return;
    const want = !on;
    setBusy(true); setErr(null);
    // the pill shows the new state at once; Steam's refusal puts it back and says why
    setSt({ signedIn: true, favorited: want }); setPops((n) => n + 1);
    try { const r = await api.workshopSetFavorite(workshopId, want); favorites.set(workshopId, r.favorited); }
    catch (e) {
      setSt({ signedIn: !(e instanceof ApiError && e.signIn), favorited: !want }); setPops((n) => n + 1);
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const n = count == null ? null : Math.max(0, count + (counted === null ? 0 : (on ? 1 : 0) - (counted ? 1 : 0)));
  const shown = fmtCount(n);
  const word = signedOut ? "Favourite on Steam" : on ? "Favourited" : "Favourite";
  return (
    <button type="button" className={`side-pill fav-pill${on ? " on" : ""}`} data-side-stat="favorites"
      data-ws-fav={st == null ? "loading" : signedOut ? "signed-out" : on ? "on" : "off"}
      aria-pressed={st?.signedIn ? on : undefined} aria-busy={st == null || busy || undefined}
      aria-label={shown ? `${word}, ${shown} favourites` : word}
      title={signedOut ? "Liascape isn't signed in to Steam: favourite it on its page in the Steam app" : err ?? undefined} onClick={toggle}>
      <Star key={pops} size={13} fill={on ? "currentColor" : "none"} className={pops ? "ico-pop" : undefined} />
      {shown != null && <span data-fav-count>{shown}</span>}
    </button>
  );
}

// what glides when the held stat pills leave: the hero row's pills and the blocks under it
const STATS_FLIP = ":scope > *, :scope > .side-hero > *";

// The Library sidebar's stat pills: Steam's current subscribers and favourites (a Browse result carries its own, shown in its
// hero), asked once the sidebar settles (GET /workshop/counts, Steam's client protocol) and kept for the session. They sit in
// the hero's row beside the other pills (ItemSide.tsx; `display: contents`, so they are the row's own items), held there
// unseen while they're asked, so they fade in where they stay (motion on: rising a little) and nothing moves; no answer
// (Steam unreachable) → the held pills leave, and what followed them glides into their room (motion off: takes it at once).
// Guard: probe-steam lib:ws:counts, lib:ws:countsOff, lib:ws:pillRow
export function WorkshopStats({ workshopId }: { workshopId: string }) {
  const settled = useSettled(workshopId);
  const [c, setC] = useState<WsCounts | null>(() => counts.get(workshopId) ?? null);
  const [failed, setFailed] = useState(false);
  const motionOn = useMotion();
  const ref = useRef<HTMLSpanElement>(null);
  // the hero row and the body under it, measured as the failure lands (before the held pills go)
  const flip = useRef<{ snap: FlipSnap | null; root: Element } | null>(null);
  useEffect(() => {
    if (!settled || counts.has(workshopId)) return;
    let alive = true;
    api.workshopCounts(workshopId).then((r) => { counts.set(workshopId, r); if (alive) setC(r); })
      .catch(() => {
        if (!alive) return;
        const root = ref.current?.closest(".side-body");
        if (root && motionOn) flip.current = { snap: snapFlip(root, STATS_FLIP), root };
        setFailed(true);
      });
    return () => { alive = false; };
  }, [settled, workshopId]); // eslint-disable-line react-hooks/exhaustive-deps
  const gone = failed && !c;
  useLayoutEffect(() => {
    const f = flip.current; flip.current = null;
    if (gone && f) glideFlip(f.snap, f.root, STATS_FLIP);
  }, [gone]);
  if (gone) return null;
  // the held pills' stand-ins: the widths of numbers like Steam's, so the real ones land about where they show
  return (
    <span ref={ref} className="ws-stats" data-ws-stats={c ? "known" : "loading"} aria-hidden={!c || undefined}>
      <StatPills subscriptions={c?.subscriptions ?? 1000} favorites={c?.favorites ?? 100}
        fav={<FavoritePill workshopId={workshopId} count={c?.favorites ?? 100} />} />
    </span>
  );
}
const rel = (t: number) => {
  const s = Date.now() / 1000 - t;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

// The comment thread: newest first, PAGE at a time ("Show older"), each comment's avatar, name (the creator's marked), time and
// text — plain text only, as React text (the backend already took it out of Steam's HTML; nothing here is ever parsed as
// markup). Read the first time the section comes into view; a box to post one when signed in, else "Comment on Steam" in its
// place (the item's page in the Steam app), rising in with the comments (motion off: fading).
// Guard: probe-steam ws:comments, ws:commentsOff, ws:commentPost
export function CommentsSection({ workshopId, authorId }: { workshopId: string; authorId: string | null | undefined }) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  const [list, setList] = useState<WsComment[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [owner, setOwner] = useState<string | null>(authorId ?? null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null); // the comment just posted: it slides in on top
  const openOnSteam = useStore((s) => s.openOnSteam);
  const load = async (start: number) => {
    setState("loading"); setErr(null);
    try {
      const r = await api.workshopComments(workshopId, owner, start, PAGE);
      setOwner(r.owner); setSignedIn(r.signedIn); setTotal(r.total);
      setList((l) => (start === 0 ? r.comments : [...l, ...r.comments.filter((c) => !l.some((x) => x.id === c.id))]));
      setState("idle");
    } catch (e) { setState("error"); setErr(e instanceof Error ? e.message : String(e)); }
  };
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  // in view (the sidebar's own scroller) → read; the observer goes once it has fired
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { setSeen(true); loadRef.current(0); } },
      { root: el.closest(".side-scroll"), rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  const post = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || posting) return;
    setPosting(true); setPostErr(null);
    try {
      const r = await api.workshopPostComment(workshopId, owner, t, PAGE);
      setText(""); setList(r.comments); setTotal(r.total); setFresh(r.comments[0]?.id ?? null);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.signIn) setSignedIn(false);
      setPostErr(e2 instanceof Error ? e2.message : String(e2));
    } finally { setPosting(false); }
  };
  const more = total != null && list.length < total;
  return (
    <section ref={ref} className="side-sec ws-comments" data-ws-comments={total == null ? state : "loaded"}>
      <h3 className="side-sec-title"><span className="side-sec-ico"><MessageSquare size={15} /></span>Comments
        {total != null && <span className="side-sec-extra ws-count" data-ws-count={total}>{total}</span>}</h3>
      {signedIn === false && (
        <button type="button" className="btn ghost ico ws-steam-comment" data-ws-steam-comment onClick={() => void openOnSteam(workshopId)}
          title="Liascape isn't signed in to Steam: comment on its page in the Steam app">
          <ExternalLink size={14} /> Comment on Steam
        </button>
      )}
      {signedIn && (
        <form className="ws-post" onSubmit={post} data-ws-post>
          <textarea value={text} maxLength={1000} rows={2} placeholder="Add a comment…" aria-label="Your comment" disabled={posting}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) post(e); }} />
          <button type="submit" className="btn accent ico ws-post-btn" disabled={posting || !text.trim()} data-ws-post-btn>
            {posting ? <LoaderCircle size={14} className="side-sub-spin" /> : <Send size={14} />} Post
          </button>
          {postErr && <span className="ws-note warn" role="alert" data-ws-post-error>{postErr}</span>}
        </form>
      )}
      {total === 0 && <p className="ws-note" data-ws-empty>No comments yet</p>}
      <ol className="ws-list">
        {list.map((c) => (
          <li key={c.id} className={`ws-c${c.id === fresh ? " fresh" : ""}`} data-ws-comment={c.id}>
            <Avatar src={c.avatar} size={26} />
            <div className="ws-c-body">
              <div className="ws-c-head">
                <b className="ws-c-name" data-ws-c-name>{c.author}</b>
                {c.authorId && c.authorId === owner && <span className="ws-c-op">Creator</span>}
                {/* a time Steam's markup didn't give (0) shows nothing rather than 1970 */}
                {c.time > 0 && <span className="ws-c-time" data-ws-c-time={c.time} title={new Date(c.time * 1000).toLocaleString()}>{rel(c.time)}</span>}
              </div>
              <p className="ws-c-text" data-ws-text>{c.text}</p>
            </div>
          </li>
        ))}
      </ol>
      {state === "loading" && <p className="ws-note" data-ws-loading><LoaderCircle size={13} className="side-sub-spin" /> Loading comments…</p>}
      {state === "error" && (
        <p className="ws-note" data-ws-error>Couldn't load the comments{err && /try again in/.test(err) ? ` — ${err}` : ""}
          <button type="button" className="mini ico ws-retry" onClick={() => load(list.length)}><RotateCcw size={13} /> Retry</button></p>
      )}
      {more && state === "idle" && <button type="button" className="btn ghost ws-more" data-ws-more onClick={() => load(list.length)}>Show older</button>}
    </section>
  );
}

// A Workshop list that couldn't be read (store wsListNote), or one that's empty, says so where the grid would be: Steam's own
// words, or what's empty. Guard: probe-steam ws:presetsEmpty
export function WsListNote() {
  // a local set (a Yours row ✓) isn't the list's pages: neither the list's error nor its emptiness is the set's.
  // Guard: probe-steam yours:inList
  const local = useStore((s) => s.localSetOn());
  const note = useStore((s) => s.wsListNote);
  const empty = useStore((s) => !!s.wsList && !s.loading && !s.hasMore && s.wallpapers.length === 0 && s.browseFor !== "");
  const kind = useStore((s) => s.wsList?.kind);
  if (local || (!note && !empty)) return null;
  const text = note ? note.text
    : kind === "presets" ? "This scene has no presets yet — or none that match these filters." : "No wallpapers here match these filters.";
  return <div className="wf-none ws-list-note" data-ws-list-note={note ? "error" : "empty"}><span>{text}</span></div>;
}
