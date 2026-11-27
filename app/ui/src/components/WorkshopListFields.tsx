import { memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, SlidersHorizontal, X } from "lucide-react";
import { api, type WsList } from "../api/client";
import { listGenNow, nextListGen, presetsOn, useStore } from "../store";
import { useLinger } from "../hooks/useLinger";
import { useMotion } from "./motion";
import { Avatar } from "./WorkshopSocial";
import { CooldownWords } from "./SteamCooldown";
import { useAfterCooldown } from "../hooks/useAfterCooldown";

// COOL: the Workshop filter column's two list fields (components/WorkshopFilterColumn.tsx, the Workshop's scope only), at its
// top: Author (a Steam ID, a profile link, or a name the app has seen: the backend resolves it, GET /workshop/author,
// Helpers/SteamAuthors.cs) and Presets of (a scene's Workshop ID or link, read here). Each is the store's one Workshop list
// (`wsList`: a creator's items, a scene's presets) as text: it shows the open list's name (else its id), a commit (Enter, or
// leaving the field) opens what it names, emptying it (its × or the text deleted) leaves that list for the whole Workshop.
// The sidebar's creator and presets rows fill them (WorkshopSocial.tsx fillListField). What a field can't take shows in the
// field's own error state, never as a line under it: its box turns the danger colour and its heading line names what to
// paste instead; the typed text stays to fix. docs/decisions.md § "Pick a creator's or a scene's list in the filter column".
// Guard: probe-steam list:*
// Steam's cooldown refusing a lookup (a custom profile name's page) is that error state too, its words the cooldown's own
// counting down (SteamCooldown.tsx), and the field asks again by itself at its end. Guard: probe-steam cool:author

// a scene's Workshop id from what was pasted: the id itself, or its Workshop page's link (`…/filedetails/?id=<id>`)
function workshopIdOf(text: string): string | null {
  const t = text.trim();
  if (/^\d{1,20}$/.test(t)) return t;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    if (!/^(www\.)?steamcommunity\.com$/i.test(u.hostname) || !/^\/(sharedfiles|workshop)\/filedetails\/?$/.test(u.pathname)) return null;
    const id = u.searchParams.get("id");
    return id && /^\d{1,20}$/.test(id) ? id : null;
  } catch { return null; }
}

async function authorList(text: string): Promise<WsList> {
  const r = await api.workshopAuthor(text);
  return { kind: "creator", id: r.steamId, name: r.name, avatar: r.avatar };
}

async function presetsList(text: string): Promise<WsList> {
  const id = workshopIdOf(text);
  if (!id) throw new Error("Paste the scene's Workshop ID or link");
  // its name and its own card (the presets' "Uses" row brings it back): a shown card, the library's copy, else Steam's
  // details (the client protocol and the details cache, not the rate-limited community site; none: the id shows)
  const s = useStore.getState();
  const held = s.wallpapers.find((w) => w.workshopId === id) ?? s.wsLibDetails[id] ?? null;
  const lib = s.libraryItems.find((x) => x.workshopId === id)?.title ?? null;
  const scene = held ?? (lib ? null : await api.workshopDetails([id]).then((r) => r.items[0] ?? null, () => null));
  return { kind: "presets", id, name: scene?.title ?? lib, scene };
}

type Kind = "creator" | "presets";
const keyOf = (l: WsList) => (l ? `${l.kind}:${l.id}` : "");
// the list each field last rang for, across mounts: a row's click opens the column with the field in it (the field mounts
// already filled) and it rings then, but Browse built again on a visit shows the same list without a ring
const rung: Record<Kind, string> = { creator: "", presets: "" };
function ListField({ kind, label, placeholder, lead, resolve }: {
  kind: Kind; label: string; placeholder: string; lead: (list: WsList) => ReactNode; resolve: (text: string) => WsList | Promise<WsList>;
}) {
  const list = useStore((s) => (s.wsList?.kind === kind ? s.wsList : null));
  const setWsList = useStore((s) => s.setWsList);
  const motion = useMotion();
  const shown = list ? list.name ?? list.id : "";
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // the error is Steam's cooldown (its live words in the error's place; committed again at its end, unless a newer list
  // operation came since: the generation the refused commit took)
  const [cooled, setCooled] = useState(false);
  const coolGen = useRef(0);
  // the commit the field waits on: an older one's answer is dropped (the user typed on or cleared it: `seq`; a newer commit
  // in either field, a source switch, a row's fill or Clear all: the store's list generation; a list opened from elsewhere:
  // the store's list changed under it)
  const seq = useRef(0);
  const asking = useRef<string | null>(null); // the text being resolved: its blur after Enter asks nothing again
  // a list opened from elsewhere (a sidebar row, another field, the source pill) replaces what was being typed, and rings the
  // field once (its key: a fresh ring per fill)
  const key = keyOf(list);
  const anyKey = useStore((s) => keyOf(s.wsList)); // the Workshop's list, whichever field it belongs to
  const [seen, setSeen] = useState(key);
  const [seenAny, setSeenAny] = useState(anyKey);
  const [rings, setRings] = useState(() => (key && rung[kind] !== key ? 1 : 0));
  useEffect(() => { rung[kind] = key; }, [kind, key]);
  if (seenAny !== anyKey) {
    setSeenAny(anyKey);
    if (draft !== null || err) { setDraft(null); setErr(null); setBusy(false); setCooled(false); }
  }
  if (seen !== key) {
    setSeen(key);
    if (key) setRings((n) => n + 1);
  }
  const shownErr = useLinger(err, 160, motion);
  const id = useId();
  const value = draft ?? shown;

  const commit = async () => {
    if (draft === null) return;
    const t = draft.trim();
    if (busy && asking.current === t) return;
    const n = ++seq.current;
    setCooled(false);
    if (!t || (list && t === shown)) { setDraft(null); setErr(null); setBusy(false); if (!t && list) setWsList(null); return; }
    asking.current = t;
    setBusy(true);
    const at = keyOf(useStore.getState().wsList), gen = nextListGen();
    const stale = () => n !== seq.current || gen !== listGenNow() || keyOf(useStore.getState().wsList) !== at;
    // overtaken by something newer that this field's own state doesn't follow (the other field, Clear all): the field lets go
    // of what it was asking (still its own newest commit), never spinning on
    const drop = () => { if (n === seq.current) { setDraft(null); setErr(null); setBusy(false); } };
    try {
      const l = await resolve(t);
      if (stale()) { drop(); return; }
      setDraft(null); setErr(null); setBusy(false);
      setWsList(l);
    } catch (e) {
      if (stale()) { drop(); return; }
      setBusy(false);
      coolGen.current = gen;
      setCooled(useStore.getState().noteSteamRefusal(e));
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const commitRef = useRef(commit);
  useEffect(() => { commitRef.current = commit; });
  // still waiting on the cooldown with the same text: it goes again once Steam lets requests through
  // Guard: probe-steam cool:author, cool:authorStale
  useAfterCooldown(cooled && !!err && draft !== null, () => {
    if (listGenNow() !== coolGen.current) { setCooled(false); return; }
    asking.current = null; void commitRef.current();
  });
  const clear = () => {
    seq.current++;
    setDraft(null); setErr(null); setBusy(false); setCooled(false);
    if (list) setWsList(null);
  };

  return (
    <div className="wf-field" data-wf-field={kind} data-wf-field-state={busy ? "busy" : err ? "error" : list ? "on" : "off"}>
      <div className="wf-field-head">
        <label className="wf-field-name" htmlFor={id}>{label}</label>
        {shownErr.value && (
          <span id={`${id}-err`} className={`wf-field-err${shownErr.closing ? " closing" : ""}`} role="alert" data-wf-field-err
            title={shownErr.value} data-wf-field-cool={cooled || undefined}>{cooled && !shownErr.closing ? <CooldownWords short /> : shownErr.value}</span>
        )}
      </div>
      <div className="wf-field-box">
        {rings > 0 && <span key={rings} className="wf-field-ring" aria-hidden="true" />}
        <span className="wf-field-lead" aria-hidden="true">{lead(list)}</span>
        <input id={id} className="text" value={value} placeholder={placeholder} spellCheck={false} autoComplete="off"
          aria-invalid={err ? true : undefined} aria-describedby={err ? `${id}-err` : undefined} aria-busy={busy || undefined}
          data-wf-dirty={draft !== null || err ? "" : undefined}
          onChange={(e) => { setDraft(e.target.value); if (err) { setErr(null); setCooled(false); } if (busy) { seq.current++; setBusy(false); } }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commit(); }
            // Escape takes back what was typed (the drawer's Escape closes it only when there's nothing to take back)
            else if (e.key === "Escape" && (draft !== null || err)) { e.preventDefault(); e.stopPropagation(); seq.current++; setDraft(null); setErr(null); setBusy(false); setCooled(false); }
          }} />
        {busy ? <span className="wf-field-x" aria-hidden="true"><LoaderCircle size={14} className="side-sub-spin" /></span>
          : value && <button type="button" className="wf-field-x" data-wf-field-clear aria-label={`Clear ${label}`}
            onMouseDown={(e) => e.preventDefault()} onClick={clear}><X size={14} /></button>}
      </div>
    </div>
  );
}

// PERF: memo'd — the column re-renders on every tag change; the fields read their own slice. Guard: probe-filters lib:interplay
export const WorkshopListFields = memo(function WorkshopListFields() {
  const presets = useStore((s) => presetsOn(s.settings));
  return (
    <section className="wf-grp wf-lists" data-wf-lists aria-label="Lists">
      <ListField kind="creator" label="Author" placeholder="Steam ID, profile link or name" resolve={authorList}
        lead={(l) => <Avatar src={l?.kind === "creator" ? l.avatar : null} size={20} />} />
      {/* a scene's presets only while presets can play (the sidebar's Presets row too: WorkshopSocial.tsx PresetsRow) */}
      {presets && <ListField kind="presets" label="Presets of" placeholder="A scene's Workshop ID or link" resolve={presetsList}
        lead={() => <SlidersHorizontal size={14} />} />}
    </section>
  );
});
