# Architect — Nov 27b fixes
Copy these files over the repo at the same paths, then commit and push. The service worker is now `architect-shell-2026-11-27b`.

- **Variables object tabs:** they no longer get clipped or scrolled out of a narrow header. Tabs that don't fit (and anything past the fifth) move into the ⌄ list, and the open tab always stays visible.
- **Phone — Fleeting Moments:** the stray dotted handle on its own row under the title is gone.
- **Phone — Path:** short day names (SAT, SUN…) so the five days and the calendar button fit on one line.
- **Path:** once a later date is opened from the calendar, the calendar button shows that date (e.g. "DEC 11").
- **Blueprint windows:** when the window is short, the tools pill scrolls (with a fade) instead of looking cut off. Undo/Redo stay visible below it.
- **Variables sync:** if your account was unreachable at load and you edited something, your edits are saved once it reconnects instead of being replaced.
