// ---------- LoadMode undo/redo command stack ----------
// A tiny, reusable per-key command stack. Each key (e.g. a shipment
// refId) owns an independent undo/redo history so unrelated surfaces
// never cross-contaminate. Entries are opaque to the stack — callers
// decide what a "command" is (typically { before, after, label }) and
// how to apply it. History is capped so long editing sessions can't
// grow memory without bound.
//
// Currently wired to the cost/sell breakdown editor in app.js, but the
// API is generic so other surfaces can adopt it later:
//
//   LoadModeUndoStack.push(key, entry)   // record a new command; clears redo
//   LoadModeUndoStack.canUndo(key)       // -> boolean
//   LoadModeUndoStack.canRedo(key)       // -> boolean
//   LoadModeUndoStack.peekUndo(key)      // -> entry | null (next undo target)
//   LoadModeUndoStack.peekRedo(key)      // -> entry | null (next redo target)
//   LoadModeUndoStack.undo(key)          // -> entry | null (moves it to redo)
//   LoadModeUndoStack.redo(key)          // -> entry | null (moves it to undo)
//   LoadModeUndoStack.clear(key)         // drop a key's history
//
(function installUndoStack() {
  if (window.LoadModeUndoStack) return;

  // Cap per-key history depth. Undo entries beyond this are dropped
  // from the oldest end.
  const MAX_HISTORY = 50;

  // key -> { undo: entry[], redo: entry[] }
  const stacks = new Map();

  function get(key) {
    let s = stacks.get(key);
    if (!s) {
      s = { undo: [], redo: [] };
      stacks.set(key, s);
    }
    return s;
  }

  const CommandStack = {
    push(key, entry) {
      const s = get(key);
      s.undo.push(entry);
      if (s.undo.length > MAX_HISTORY) s.undo.shift();
      // A fresh action invalidates any redo branch.
      s.redo.length = 0;
    },
    canUndo(key) {
      return get(key).undo.length > 0;
    },
    canRedo(key) {
      return get(key).redo.length > 0;
    },
    peekUndo(key) {
      const s = get(key);
      return s.undo.length > 0 ? s.undo[s.undo.length - 1] : null;
    },
    peekRedo(key) {
      const s = get(key);
      return s.redo.length > 0 ? s.redo[s.redo.length - 1] : null;
    },
    undo(key) {
      const s = get(key);
      if (s.undo.length === 0) return null;
      const entry = s.undo.pop();
      s.redo.push(entry);
      return entry;
    },
    redo(key) {
      const s = get(key);
      if (s.redo.length === 0) return null;
      const entry = s.redo.pop();
      s.undo.push(entry);
      return entry;
    },
    clear(key) {
      stacks.delete(key);
    },
  };

  window.LoadModeUndoStack = CommandStack;
})();
