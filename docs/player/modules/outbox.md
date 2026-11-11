<!-- Archived verbatim from .claude/rules/player-core.md (2026-11-11 docs rework). Module walkthrough + its
     history. NOT loaded automatically and may be stale: the code and .claude/rules/player/*.md win. -->

## Outbox

`src/outbox.rs` (Phase 3 Task 9, plan designer call 6). What the backend must persist even when it isn't
listening — with the app closed (the player rotates by itself, Phase 3), or in a reconnect gap — is kept in
`<state>/outbox.jsonl` until the backend acks it: `source.broken` (→ the item is marked crashed), `scene.loudness` (→ the
index) and `scene.vram_exceeded` (UI text only). The backend drains it on every (re)subscription (player-adapter.md
§ Event flow → "Outbox").

- **Where:** `crate::outbox::with_seq(kind, &mut fields)` at the three points that log them (`SceneSource::log_broken`,
  `report_loudness`, `stop_for_vram`) appends the event's fields, then adds `outbox_seq` to the live event (and the log
  record) — the backend acks what it handled live by it. The outbox is process-global (`outbox::install`, once in
  `serve`, after the snapshot writer exists); without one (a harness) `append` is a no-op and no `outbox_seq` appears.
  `hello.capabilities` has `outbox`.
- **Lines:** `{"seq":N,"t_wall":…,"kind":…,"fields":{…}}` — `seq` written first by hand (serde_json sorts keys) so a
  read skips lines without parsing them. `seq` is monotonic across restarts: at open it continues after the last
  line, `outbox.state.json`'s `last_seq` or its `acked`, whichever is newest (an acked, compacted-empty file still
  continues). A failed append uses no seq (`outbox.write_failed {op: append}` once per streak, `write_recovered`).
- **Appends:** `O_APPEND`, one `write` per line, any thread, one mutex; never `fsync`ed (a crash keeps it in the page
  cache; a power loss can lose the newest lines). A torn last line found at open is ended with `\n` and never read.
- **Bound:** `OUTBOX_MAX` = 2000 unacked entries. A read never returns an older one; `dropped_before` = the first seq
  kept when one past `after` (and the ack) was lost — the bound applied exactly at read time, plus `dropped_through`
  (persisted) for what a compaction dropped. The file is compacted once it holds `COMPACT_SLACK` = 200 lines more than
  the bound (no rewrite per append past it), and at open when it is past the bound or holds acked lines;
  `outbox.dropped {n, before, max}` (warn) when unacked entries go.
- **`outbox.read {after?, limit?}`** (§ Command API): reads the file on the loop (≤ 2200 lines; only the backend's
  drain calls it), the entries with seq > max(after, acked), ≤ `limit` (500 by default, at most 2000).
- **`outbox.ack {seq}`:** `acked` moves at once (reads skip ≤ seq), then a compaction is queued on `lia-snapshot` (one
  at a time; another after it when asked meanwhile): the unacked entries (newest 2000) to `outbox.jsonl.tmp` + `fsync`,
  `outbox.state.json` `{last_seq, acked, dropped_through}` atomically, then **under the lock** the lines appended since
  the read are copied over, the temp renamed over the file and the append handle reopened (no `fsync` under the lock —
  the loop may append meanwhile), the dir `fsync`ed after. A crash before the rename leaves the old file and the new
  state: the acked lines are skipped at open and compacted then. `outbox.compacted {kept, acked, carried, ms}` (debug).
- **Idempotence is the contract:** a fact can be delivered twice (live and drained, or drained again after a crash
  before its ack) — every backend handler of it must be idempotent.
- Tests: units in `outbox.rs` (order + reopen, ack + an empty file's seq, a lost compaction, 2500 appends past the
  bound, a torn line, a queued compaction), api `outbox_persists_across_restart_and_acks`, `outbox_is_bounded`,
  `live_events_carry_outbox_seq`, and `scene_over_vram_limit_is_stopped_not_crashed` (its `outbox_seq`).
