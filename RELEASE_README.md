# PITCHDECK for macOS

This package contains the Apple Silicon build of PITCHDECK 0.1.0.

## Install

1. Unzip the download.
2. Drag `PITCHDECK.app` to your Applications folder.
3. Open PITCHDECK from Applications.

The app is ad-hoc signed and locally validated, but it is not notarized with an
Apple Developer ID. If macOS blocks the first launch, Control-click the app and
choose **Open**. If macOS still blocks it, use your installed copy of
**Sentinel** to remove quarantine from `PITCHDECK.app`, then open the app again.
Only trust the app downloaded from the Hax0rgurl/PitchDeck GitHub release. Do
not disable Gatekeeper globally.

## What is included

- PITCHDECK's Electron desktop app and local backend
- The custom PITCHDECK app icon
- Project saving and ZIP export
- Story, character, screenplay, and 12-shots-per-minute storyboard workflows

Large AI model weights are intentionally not bundled.

## Optional local backends

PITCHDECK can discover and report these local tools when installed:

- Ollama for local writing
- Phosphene/LTX for image-to-video and text-to-video
- mflux/Qwen Image Edit for reference-conditioned still generation

PITCHDECK still opens if an optional backend is unavailable. The Local Models
panel reports what is missing so it can be configured later.

## Requirements

- Apple Silicon Mac (`arm64`)
- macOS 12 or later

## Support note

The source repository currently does not declare an open-source license. The
download is provided by the repository owner for its intended users.
