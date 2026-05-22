# PITCHDECK Local

Local-first standalone experiment for the movie storyboard pipeline.

This is the local Mac/Electron version of the PITCHDECK movie storyboard pipeline. It keeps the same production logic:

- 1 shot = 5 seconds
- 12 shots = 1 minute
- 5 minutes = 60 shots
- characters and references are stable records
- prompts are complete, visual-only, and self-contained
- Phosphene is used as the local image-to-video / text-to-video backend
- Ollama is used for local agent writing when available
- mflux/Qwen Image Edit is used for local reference-conditioned still generation

The app bundle does not include model weights. Models live outside the repo and can be installed/repaired through the Local Models panel.

## Current Slice

Wired now:

- Ollama status and local model selection
- Phosphene status and queue submission
- mflux/Qwen Image Edit adapter status and generation endpoint
- local model manager endpoint and UI panel for installing/repairing the Qwen Image Edit q4 weights
- packaged Electron shell that starts the local backend and opens the app as `PITCHDECK`
- FilmDev role flow inspired by ChatDev PromptFlow structure
- character profile generation
- screenplay generation
- minute-by-minute storyboard generation with exactly 12 shots
- deterministic full image prompt builder
- face/still uploads stored as browser data URLs
- per-shot local still generation through mflux/Qwen Image Edit when at least one accessible reference image is attached
- project save to `data/projects`
- ZIP export with project JSON, screenplay, prompts, and attached still images

## Run

Prerequisites for the full pipeline:

- macOS on Apple Silicon
- Node.js and npm
- Ollama with a local writing model such as `qwen3.5:latest`
- mflux Qwen Image Edit CLI at `/Users/muse/.local/bin/mflux-generate-qwen-edit` or set `MFLUX_BIN`
- Qwen Image Edit q4 weights, installed through the app model panel or set with `MFLUX_QWEN_EDIT_MODEL`
- Phosphene/LTX backend, currently discovered at `/Users/muse/pinokio/api/phosphene.git` or set `PHOSPHENE_ROOT`

Install dependencies:

```sh
npm install
```

Development server:

```sh
npm run dev
```

Packaged Mac app:

```sh
npm run package:mac
open -n "release/mac-arm64/PITCHDECK.app"
```

One-step development desktop launch:

```sh
./script/build_and_run.sh
```

Health check:

```sh
curl http://127.0.0.1:5179/api/status
```

Not wired yet:

- automatic avatar generation
- pitch deck HTML layout parity with the WebSim app
- FFmpeg assembly/editing

## Repository Policy

The repository intentionally excludes:

- `node_modules/`
- `dist/`
- `release/`
- `data/`
- `models/`

Generated projects, exported apps, and model weights are local runtime artifacts, not source files.
