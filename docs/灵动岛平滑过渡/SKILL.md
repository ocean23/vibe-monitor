---
name: notch-island-macos
description: Build or refine macOS apps that visually integrate with the MacBook notch or menu-bar safe area, including dynamic-island style NSPanel overlays, hover-to-expand behavior, notch-aware geometry, SwiftUI controls, smooth resize/morph animation, and status-bar companion UI. Use when the user asks to create, debug, polish, or design a notch-based macOS utility, timer, focus app, dashboard, floating control, or dynamic island interaction.
---

# Notch Island macOS

Use this skill for macOS apps that live around the MacBook notch and behave like a compact dynamic island: small by default, expanded on hover or click, then smoothly returning to a notch-integrated compact state.

## Core Model

Treat the visible island and the AppKit window as separate layers:

- `NSPanel` is the transparent interaction envelope.
- SwiftUI renders the visible island shell and content.
- Animation should primarily change SwiftUI shell geometry, not repeatedly replace or hide windows.
- Window frame changes are allowed only at mode boundaries or when the transparent envelope must grow before visible content expands.

Prefer this architecture:

```swift
NSPanel transparent envelope
  -> NSHostingView
    -> SwiftUI island shell
      -> background shape
      -> content for compact / running / expanded
      -> overlay effects
```

## Geometry Workflow

1. Detect the active screen and notch-safe top inset.
2. Compute three target visual modes:
   - `runningCompact`: default mouse-away island, as small as possible, only around notch sides.
   - `compact`: hover/action-ready size.
   - `expanded`: temporary control panel.
3. Compute panel size separately:
   - For compact/running, keep a stable panel envelope large enough for hover detection.
   - For expanded, grow the transparent panel before visible content grows.
4. Keep visible island position stable across panel frame changes:
   - Store the visible island global frame before rebasing.
   - Change the panel frame.
   - Recompute `offsetX` so the visible island does not jump.

Avoid anchoring resize from only the left or right edge. The island should appear attached to the notch center unless there is a deliberate side-bias design.

## Interaction Rules

Use deterministic mode resolution:

```swift
if isExpanded {
    displayMode = .expanded
} else if isHovered {
    displayMode = .compact
} else {
    displayMode = .runningCompact
}
```

Recommended behavior:

- Mouse enters island: expand to `compact`.
- Mouse exits island: contract to `runningCompact` immediately.
- Click primary action outside expanded: perform action and contract to `runningCompact`.
- Click expand: enter `expanded`; ignore hover-exit until expanded has settled or user collapses.
- Click collapse: contract to `compact` if still hovered, otherwise `runningCompact`.

Do not add perceptible hover-exit delays. If debounce is needed, keep it within the same run loop or make it visually unnoticeable.

## Animation Rules

Use a single motion engine for visible geometry:

- Drive animation with display-link style updates where possible.
- Keep `width`, `height`, `offsetX`, and `cornerRadius` in one motion snapshot.
- Use separate profiles for expand and contract.
- Contracting should start on the first frame and finish in about 180-240 ms.
- Expansion can use a softer spring.

Common bug to avoid:

- Do not apply `scaleEffect` to an entire content tree during mode transitions if text must stay stable. It makes labels appear to grow or shrink.
- Do not let text reflow through animated parent width. For expanded content, lay out against the final width and let the shell reveal/crop it.
- Do not swap content by setting it empty mid-transition. Keep source and target content alive and crossfade/blur/offset them.
- Do not call `panel.setFrame(...)` at the end and then snap the SwiftUI shell; this causes visible jumps.

Good content transition pattern:

```swift
ZStack(alignment: .top) {
    sourceContent
        .opacity(1 - sourcePhase)
        .blur(radius: sourcePhase * 1.5)
        .offset(y: -sourcePhase * 3)

    targetContent
        .opacity(targetPhase)
        .blur(radius: (1 - targetPhase) * 1.5)
        .offset(y: (1 - targetPhase) * 4)
}
```

## Visual Design

For a notch-integrated island, prioritize restraint:

- Use a black or near-black shell that visually merges with the physical notch.
- Keep corner radius continuous across all modes.
- Align top edge to screen top; round only lower corners unless a detached bubble is intentional.
- Keep running compact height close to the menu-bar/notch depth.
- Avoid shadows or glow around the island if the goal is physical notch integration.
- Avoid tall expanded panels; expanded should still feel like an island, not a floating window.
- Keep text stable-width with `.monospacedDigit()` for timers.
- Use icon-only controls with tooltips for common actions.

For expanded state:

- Limit to one primary action and one or two secondary icon buttons.
- Do not overload with settings, statistics, or complex controls.
- Put complex dashboards in a separate macOS window.
- If a motivational line or identity label exists, keep it one line and secondary.

## State and Data

Separate product state from presentation state:

- Timer/session state should not decide island size.
- Hover/expanded state should decide island geometry.
- Start/pause should usually only change icon, progress, or feedback.
- If a user starts an action and expects the island to shrink, explicitly override hover with a primary-action collapse rule.

For demo or empty states:

- Use display-only sample data in dashboards if needed.
- Do not write fake records to persistent user data.
- Clearly mark sample data if it appears in a settings or statistics window.
- Automatically switch to real data after the first real user record.

## AppKit Requirements

Configure the panel like a system overlay:

```swift
panel.backgroundColor = .clear
panel.isOpaque = false
panel.hasShadow = false
panel.acceptsMouseMovedEvents = true
panel.hidesOnDeactivate = false
panel.isReleasedWhenClosed = false
panel.level = .statusBar
panel.collectionBehavior = [
    .canJoinAllSpaces,
    .fullScreenAuxiliary,
    .ignoresCycle,
    .stationary
]
```

Use an `NSHostingView` subclass that accepts first mouse if the island has controls:

```swift
final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}
```

## Validation Checklist

Manually verify these cases:

- Mouse enters: island expands without lateral jump.
- Mouse exits: island contracts immediately and smoothly.
- Repeated enter/exit: animation reverses without waiting for previous settle.
- Click primary action: icon/state changes without unintended size jump.
- Click expand: opens on first click.
- Click collapse: shrinks without blank rectangles or corner-radius snapping.
- Text does not scale during transition.
- Timer digits do not change layout width.
- Window shadows or transparent leftovers are not visible around the notch.
- Multi-display or screen parameter changes reposition the panel.

Run:

```bash
swift build
swift test
Scripts/package_app.sh release
```

When possible, inspect real screenshots or recordings frame by frame. Many notch-island bugs are visible only during transitions, not in final static states.
