# Nov 29b: Side Chat no longer stuck on "Sending…"

- Each save now clears every message sent before that save started. Before, if you kept typing (or something else changed), the "saved" signal never fired, so messages stayed on Sending… forever.
- A save that runs when you leave or hide the tab also reports back now.
- Safety net: if nothing on this device is waiting to save, Sending… clears after a couple of seconds.
- "Sending…" / "Not sent" now sits under the bubble, not beside it.
- sw.js version: architect-shell-2026-11-29b.
