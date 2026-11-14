import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { ArrowRight, LoaderCircle, MessageSquare, RotateCcw, Send, Star, User } from "lucide-react";
import { api, thumb, ApiError, type WsComment, type WsCreator } from "../api/client";
import { useStore } from "../store";
import { CopyButton } from "./CopyButton";

// The Browse sidebar's Workshop community pieces (BrowseSide.tsx): the creator, the favourite toggle and the comment thread
// (the backend: Web/WorkshopSocialOps.cs). Reading works signed out; favouriting and posting need the Steam sign-in and say
// "Sign in to …" without it. A failed read is a quiet line in place, never a crash or a status-bar error. Steam limits its
// community site per IP (every call is spaced and stops during its cooldown — Helpers/SteamGate.cs), so the sidebar asks
// only for what the user looks at: the creator and the favourite once the sidebar has stayed on an item for SETTLE_MS (a
// run of arrow keys asks for nothing), the comments once their section scrolls into view, and each answer is kept for the
// session.

const SETTLE_MS = 350;
const PAGE = 10;
const creators = new Map<string, WsCreator>(); // per Workshop item
const favorites = new Map<string, boolean>(); // per Workshop item, signed in

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

// The creator: their avatar and name; a click lists every Wallpaper Engine item they made in Browse (store setWsList —
// a source pill of its own, components/SourcePills.tsx). The name can be selected, and copied by the Copy that floats at the
// end of the "Made by" line while the row is hovered or holds the keyboard focus. Guard: probe-steam ws:creator, ws:creatorCopy
export function CreatorRow({ workshopId, authorId }: { workshopId: string; authorId: string | null | undefined }) {
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
  // the name is selectable: a drag that selected some of it isn't a click on the row
  const go = (e: MouseEvent<HTMLButtonElement>) => {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return;
    if (id) setWsList({ kind: "creator", id, name: c?.name ?? null, avatar: c?.avatar ?? null });
  };
  return (
    <div className="ws-creator-row">
      <button type="button" className={`ws-creator${name ? "" : " loading"}`} data-ws-creator={c ? "known" : failed ? "unknown" : "loading"}
        disabled={!id} onClick={go}>
        <Avatar src={c?.avatar} size={30} />
        <span className="ws-creator-text">
          <span className="ws-creator-by">Made by</span>
          <span className="ws-creator-name" data-ws-creator-name>{name ?? "…"}</span>
        </span>
        <span className="ws-creator-go">All their wallpapers <ArrowRight size={14} /></span>
      </button>
      {/* only Steam's own name: "Steam creator" stands in for one it couldn't read */}
      {c?.name && <CopyButton text={c.name} what="creator's name" className="side-copy" />}
    </div>
  );
}

// The favourite: a toggle tile (the sidebar's tiles' material) — a star that fills when it's in the account's Steam favourites,
// the words "Favourite" / "Favourited" sharing one cell (index.css .xfade) so the tile keeps its size; the new state's star
// pops once on a user change, never on mount (index.css .ico-pop). Signed out it says so and does nothing.
// Guard: probe-steam ws:favorite, ws:favoriteOff
export function FavoriteTile({ workshopId }: { workshopId: string }) {
  const settled = useSettled(workshopId);
  const [st, setSt] = useState<{ signedIn: boolean; favorited: boolean | null } | null>(() =>
    favorites.has(workshopId) ? { signedIn: true, favorited: favorites.get(workshopId)! } : null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pops, setPops] = useState(0); // user changes: the star's key, so each one pops once
  useEffect(() => {
    if (!settled || favorites.has(workshopId)) return;
    let alive = true;
    api.workshopFavorite(workshopId).then((r) => { if (r.signedIn && r.favorited != null) favorites.set(workshopId, r.favorited); if (alive) setSt(r); })
      .catch(() => { if (alive) setSt({ signedIn: true, favorited: null }); });
    return () => { alive = false; };
  }, [settled, workshopId]);
  const on = st?.favorited === true;
  const signedOut = st?.signedIn === false;
  const toggle = async () => {
    if (!st?.signedIn || busy) return;
    const want = !on;
    setBusy(true); setErr(null);
    // the tile shows the new state at once; Steam's refusal puts it back and says why
    setSt({ signedIn: true, favorited: want }); setPops((n) => n + 1);
    try { const r = await api.workshopSetFavorite(workshopId, want); favorites.set(workshopId, r.favorited); }
    catch (e) {
      setSt({ signedIn: !(e instanceof ApiError && e.signIn), favorited: !want }); setPops((n) => n + 1);
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };
  const label = signedOut ? "Sign in to favourite" : on ? "Favourited" : "Favourite";
  return (
    <button type="button" className={`side-tile fav-tile${on ? " on" : ""}`} data-ws-fav={st == null ? "loading" : signedOut ? "signed-out" : on ? "on" : "off"}
      aria-pressed={st?.signedIn ? on : undefined} aria-busy={st == null || busy || undefined} disabled={signedOut}
      title={signedOut ? "Sign in under Settings → Getting Workshop wallpapers" : err ?? undefined} onClick={toggle}>
      <span className="side-tile-ico">
        <Star key={pops} size={15} fill={on ? "currentColor" : "none"} className={pops ? "ico-pop" : undefined} />
      </span>
      <span className="xfade">
        {["Favourite", "Favourited", "Sign in to favourite"].map((t) => (
          <span key={t} data-off={t === label ? undefined : ""} aria-hidden={t !== label}>{t}</span>
        ))}
      </span>
    </button>
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
// markup). Read the first time the section comes into view; a box to post one when signed in.
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
      {signedIn === false && <p className="ws-signin" data-ws-signin>Sign in to comment — Settings → Getting Workshop wallpapers</p>}
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
                <b className="ws-c-name">{c.author}</b>
                {c.authorId && c.authorId === owner && <span className="ws-c-op">Creator</span>}
                <span className="ws-c-time" title={new Date(c.time * 1000).toLocaleString()}>{rel(c.time)}</span>
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

// A Workshop list that couldn't be read (store wsListNote), or one that's empty, says so where the grid would be: "Sign in to
// …" for the favourites without a sign-in, Steam's own words otherwise. Guard: probe-steam ws:pills
export function WsListNote() {
  const note = useStore((s) => s.wsListNote);
  const empty = useStore((s) => !!s.wsList && !s.loading && !s.hasMore && s.wallpapers.length === 0 && s.browseFor !== "");
  const kind = useStore((s) => s.wsList?.kind);
  if (!note && !empty) return null;
  const text = note ? (note.signIn ? "Sign in to Steam to see your Workshop favourites — Settings → Getting Workshop wallpapers." : note.text)
    : kind === "favorites" ? "No Wallpaper Engine favourites on Steam yet — or none that match these filters." : "No wallpapers here match these filters.";
  return <div className="wf-none ws-list-note" data-ws-list-note={note ? (note.signIn ? "sign-in" : "error") : "empty"}><span>{text}</span></div>;
}
