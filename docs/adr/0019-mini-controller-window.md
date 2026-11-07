# ADR-0019: Mini controller window (PiP) and global voice shortcut

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The owner works in VS Code, Chrome, and other apps, and wants Vyomara to act
as a small controller rather than a second workspace. A small Vyom should stay
visible above those apps, show what it heard and what it is doing, and let the
owner answer approvals without switching windows.

## Decision

1. **The mini window.**
   - **What it shows:** the orb, a status line, what was heard or the last
     reply, plan progress, and the current approval question with
     **Haan / Nahi** (or **Stop** while Vyom works).
   - **When it shows:** the main window hides, minimizes, or loses focus.
   - **When it hides:** Vyomara comes back to the front.
   - **Behaviour:** it floats above other apps and full-screen spaces, is
     shown without taking focus, and can be dragged. Its position is
     remembered.
2. **One brain.** The main window's renderer owns the conversation:
   - It publishes a small `DesktopPipState` through the main process.
   - The mini window sends `DesktopPipCommand`s back. The main process
     validates the sender of every message.
   - Deletions cannot be approved from the mini window, because they still
     need the typed `DELETE` in the main window.
3. **Closing hides.** Closing the main window hides it, so voice and the
   mini window keep working. ⌘Q quits.
4. **⌥Space** toggles listening from any app. If another app has taken it,
   ⌥⇧Space is used instead.
5. **Model warm-up.** The selected model is loaded in the background at
   startup and after model or context changes, so the first reply does not
   wait for loading. This was measured at about 5 s to load, after which the
   first reply took 0.25 s.

## Consequences

- A macOS `panel` window would not work here: it hides whenever Vyomara is not
  the active app. A normal always-on-top window shown inactive is used
  instead.
- The main renderer runs with background throttling off, so voice events and
  approvals are handled promptly while it is hidden.

## Verification

Tested live in the real app:
- **Mini window:** after the close button was clicked, the main window hid and
  the mini window appeared over VS Code.
- **⌥Space:** toggled listening on and off.
- **Approvals:** "Calculator kholo" showed "Calculator kholun? Haan / Nahi"
  in the mini window, and **Haan** opened Calculator.
