// In-memory "who's typing" state for chat -- deliberately NOT persisted to
// Postgres. Typing state is the textbook case for "fine to lose": it's
// meaningless within a few seconds of being set, nobody needs it to survive
// a server restart, and persisting it would mean a database write on every
// keystroke-ish ping from every open chat thread. A plain in-memory Map with
// a short TTL is the right tool.
//
// This assumes a single Node process. That's true today (see server.js's
// single app.listen() call and its unguarded cron.schedule() jobs, which
// would double-fire if there were multiple replicas) -- but it's not pinned
// down anywhere in code, just inferred from how the app is currently run. If
// this ever moves to multiple Railway replicas, this module needs to move to
// Redis (or similar shared store) instead, since each replica would
// otherwise have its own independent, inconsistent view of who's typing.

const TYPING_TTL_MS = 6000;

const typing = new Map(); // key -> { expiresAt: number, label: string|null }

// Called when someone's client pings "I'm typing right now" -- resets their
// TTL. `label` is an optional display name, only needed for group contexts
// (Team chat) where more than one other person could be typing at once.
function setTyping(key, label) {
  typing.set(key, { expiresAt: Date.now() + TYPING_TTL_MS, label: label || null });
}

// Direct-channel lookup: is the person behind this exact key currently
// (within the TTL) typing?
function isTyping(key) {
  const entry = typing.get(key);
  return !!entry && entry.expiresAt > Date.now();
}

// Team-channel lookup: every currently-typing label under a given key
// prefix (one thread), excluding the caller's own key so you never see
// "you are typing" reflected back at yourself.
function typingLabelsWithPrefix(prefix, exceptKey) {
  const now = Date.now();
  const labels = [];
  for (const [key, entry] of typing.entries()) {
    if (key === exceptKey) continue;
    if (!key.startsWith(prefix)) continue;
    if (entry.expiresAt > now) labels.push(entry.label || "Someone");
  }
  return labels;
}

// Periodic sweep so the Map doesn't quietly accumulate stale entries from
// threads nobody reopens -- not load-bearing for correctness (isTyping/
// typingLabelsWithPrefix already check expiry themselves), just housekeeping.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of typing.entries()) {
    if (entry.expiresAt <= now) typing.delete(key);
  }
}, 60_000).unref();

module.exports = { setTyping, isTyping, typingLabelsWithPrefix };
