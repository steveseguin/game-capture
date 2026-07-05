# Spout2 Source Support Plan

## Goal

Add Spout2 as a local video source in Game Capture so VTuber and graphics apps can publish real alpha to the existing VP9 OBS alpha workflow:

`Spout sender -> Game Capture -> dual-track VP9 -> VDO.Ninja OBS plugin`

This does not add browser-native transparency. Browser viewers should remain standard color-video viewers unless a separate viewer-side chroma-key feature is added later.

## Confirmed Baseline

- Game Capture already captures `CapturedFrame::Format::BGRA` frames.
- The current VP9 alpha workflow extracts BGRA byte 3 as a grayscale alpha plane and sends it as the second VP9 video track.
- Compatible Ninja OBS plugin receivers negotiate `alpha_receive=vp9-dualtrack-v1` and receive that alpha track.
- Browser viewers remain compatible but do not composite transparency.

## SDK Compatibility

- Use upstream `leadedge/Spout2`, pinned to tag `2.007.017`.
- License is BSD-2-Clause/Simplified BSD, compatible with this AGPL project.
- Build with CMake `FetchContent`, consistent with existing dependencies.
- Link `SpoutLibrary_static` first, because it exposes a high-level receiver API and keeps Spout-specific code isolated.
- Disable Spout install targets and DirectX sample libraries in our build.
- MVP receive path: `SPOUTLIBRARY::ReceiveImage(pixels, GL_BGRA, false)`.

The MVP intentionally receives into CPU BGRA memory. That adds a copy, but it keeps the source implementation small and feeds the existing encoder path exactly. A later optimization can use `GetSenderTexture()` or DirectX texture interop to avoid the CPU readback after the workflow is proven.

## UX

- Add a source selector near the current window picker:
  - `Window`
  - `Spout2`
- In `Window` mode, keep the current window list and selected-window audio defaults.
- In `Spout2` mode:
  - Reuse the list widget with Spout sender entries.
  - Show sender name and resolution; thumbnail can initially be a generated placeholder.
  - Refresh should re-enumerate active Spout senders.
  - Audio Source should default to `None`, because Spout carries video only.
  - Go Live is enabled only when a sender is selected.
- Keep the existing VP9 alpha checkbox under advanced codec controls.
- Add a later UI indicator after MVP:
  - `Alpha detected`
  - `No alpha detected`
  - `Premultiplied alpha` toggle

## Implementation Steps

1. Add `SpoutCapture`
   - Enumerate senders.
   - Start capture by sender name.
   - Poll at configured FPS on a worker thread.
   - Receive BGRA pixels via `ReceiveImage`.
   - Emit `CapturedFrame::BGRA` through the same callback shape as `WindowCapture`.
   - Track sender resize and reconnect.

2. Add source routing in `VersusApp`
   - Add `VideoSourceMode { Window, Spout }`.
   - Add `listSpoutSenders()`.
   - Add `startCapture(mode, sourceId)`.
   - Route window capture and Spout capture into the same `onVideoFrame` handling.
   - Skip selected-window process audio for Spout unless the user chose a different audio source.

3. Add UI support
   - Add a source-mode combo.
   - Refresh the list from windows or Spout senders depending on mode.
   - Persist selected source mode.
   - Disable source controls while live, as current capture controls do.

4. Add headless/E2E support
   - Add CLI flags:
     - `--source=window|spout`
     - `--spout-sender=<name>`
   - Add E2E harness support for those flags.
   - Add a deterministic Spout sender test utility that publishes an animated RGBA pattern.

5. Testing
   - Gates: build, syntax, and existing ctest are gates only.
   - Functional testing means packaged or release-like app execution through real workflows:
     - Launch known Spout sender.
     - Launch Game Capture against that sender with VP9 alpha enabled.
     - Connect with Ninja OBS plugin.
     - Verify transparent composition over an OBS background.
     - Verify browser viewer remains non-transparent but does not break.
     - Verify sender resize and sender restart behavior.

## Risks

- `ReceiveImage` may be too CPU-heavy at high resolution/FPS. Accept for MVP; optimize later.
- Spout sender formats vary. `ReceiveImage(GL_BGRA)` should normalize common formats; log format and dimensions for diagnostics.
- VTuber sources may use premultiplied alpha. MVP may show dark fringes; add premultiplied-alpha handling after basic capture works.
- Spout is Windows-only. UI and headless flags must fail clearly elsewhere if the app is ever built non-Windows.
