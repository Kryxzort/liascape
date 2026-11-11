import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { KeyRound, LogIn } from "lucide-react";
import { useStore } from "../store";

// Steam sign-in with an account name + password (docs/decisions.md § "Offer a password sign-in beside the QR" — the
// QR needs the Steam mobile app). Step 1: account name + password → POST /steam/login. Then whatever Steam asks for, over WS
// steam-login-code: the code Steam emailed (`email`, the address's domain as the hint), the mobile authenticator's code
// (`device`), or approval in the Steam app (`confirm`, or type the app's code) → POST /steam/login/code. steam-signed-in
// closes it; steam-login-error comes back to step 1 with Steam's words (a wrong password, Steam's rate limit — never retried
// on its own). The password is an UNCONTROLLED field: read once on submit, emptied at once, never in React state or the
// store, never echoed. Escape / Cancel stop the sign-in; a click outside does nothing (it would throw away what was typed).
export function SteamPasswordModal() {
  const pw = useStore((s) => s.pwLogin);
  const start = useStore((s) => s.startPwLogin);
  const submitCode = useStore((s) => s.submitPwCode);
  const cancel = useStore((s) => s.cancelPwLogin);
  const [user, setUser] = useState("");
  const [code, setCode] = useState("");
  const pwRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const open = !!pw;
  const step = pw?.step ?? "credentials";

  // focus: the first empty field of step 1 (the password after an error), the code field on a code step
  useEffect(() => {
    if (!pw || pw.busy) return;
    const t = setTimeout(() => {
      if (pw.step === "credentials") (user.trim() ? pwRef.current : userRef.current)?.focus();
      else codeRef.current?.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [pw?.step, pw?.busy, pw?.error, pw?.retry]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCode(""); }, [pw?.step, pw?.retry]);
  useEffect(() => { if (!open) { setCode(""); if (pwRef.current) pwRef.current.value = ""; } }, [open]);

  const signIn = (e: React.FormEvent) => {
    e.preventDefault();
    const el = pwRef.current;
    const password = el?.value ?? "";
    if (!user.trim() || !password || pw?.busy) return;
    if (el) el.value = ""; // the field never keeps it
    void start(user.trim(), password);
  };
  const sendCode = (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (!c || pw?.busy) return;
    setCode("");
    void submitCode(c);
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); void cancel(); } };

  const codeText = step === "email"
    ? <>Steam sent a Steam Guard code to your email{pw?.hint ? <> at <b>{pw.hint}</b></> : null}. Enter it here.</>
    : step === "device"
      ? <>Enter the code from the Steam Guard authenticator in your Steam mobile app.</>
      : <>Approve the sign-in in your Steam mobile app — or enter the code the app shows.</>;

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="modal pl-modal pw-modal" role="dialog" aria-modal="true" aria-labelledby={`${id}-h`}
            data-steam-pw-modal data-step={step}
            initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }} transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onKeyDown={onKey}>
            <div className="modal-body">
              <h2 id={`${id}-h`} className="ico"><KeyRound size={17} /> Sign in to Steam</h2>
              {step === "credentials" ? (
                <form onSubmit={signIn} aria-busy={pw?.busy || undefined}>
                  <p className="help">Your password goes to Steam once and is never saved. Steam may ask for a Steam Guard code next.</p>
                  <label className="field-label" htmlFor={`${id}-u`}>ACCOUNT NAME</label>
                  <input ref={userRef} id={`${id}-u`} className="text wide" name="username" autoComplete="username" autoFocus
                    spellCheck={false} autoCapitalize="off" value={user} disabled={pw?.busy}
                    onChange={(e) => setUser(e.target.value)} />
                  <label className="field-label" htmlFor={`${id}-p`}>PASSWORD</label>
                  <input ref={pwRef} id={`${id}-p`} className="text wide" type="password" name="password"
                    autoComplete="current-password" disabled={pw?.busy} data-steam-pw />
                  {pw?.error && <p className="pw-err" role="alert" data-steam-pw-error>{pw.error}</p>}
                  <div className="modal-actions">
                    <button type="button" className="btn ghost" onClick={() => void cancel()}>Cancel</button>
                    <button type="submit" className="btn accent ico" disabled={pw?.busy} data-steam-pw-submit>
                      <LogIn size={15} /> {pw?.busy ? "Signing in…" : "Sign in"}</button>
                  </div>
                </form>
              ) : (
                <form onSubmit={sendCode} aria-busy={pw?.busy || undefined}>
                  <p className="pw-step" data-steam-pw-text>{codeText}</p>
                  {step === "confirm" && <p className="help pw-wait" aria-live="polite">Waiting for your approval…</p>}
                  <label className="field-label" htmlFor={`${id}-c`}>{step === "email" ? "EMAILED CODE" : "STEAM GUARD CODE"}</label>
                  <input ref={codeRef} id={`${id}-c`} className="text wide pw-code" name="code" autoComplete="one-time-code"
                    spellCheck={false} autoCapitalize="characters" maxLength={16} value={code} disabled={pw?.busy}
                    onChange={(e) => setCode(e.target.value)} data-steam-pw-code />
                  {(pw?.retry || pw?.error) && (
                    <p className="pw-err" role="alert" data-steam-pw-error>{pw?.error ?? "That code wasn't right — check it and try again."}</p>
                  )}
                  <div className="modal-actions">
                    <button type="button" className="btn ghost" onClick={() => void cancel()}>Cancel</button>
                    <button type="submit" className="btn accent ico" disabled={pw?.busy || !code.trim()} data-steam-pw-submit>
                      <LogIn size={15} /> {pw?.busy ? "Checking…" : "Continue"}</button>
                  </div>
                </form>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
