---
name: api-phosphene-git
description: Use this app-specific note when queueing storyboard stills or prompts into Phosphene from the local PITCHDECK app.
---

# Phosphene API Delta

Phosphene exposes a local HTTP panel with these automation endpoints:

- `GET /status` returns queue, history, helper, model, memory, and readiness state.
- `POST /upload` accepts multipart form data with field `image` and returns a local filesystem `path`.
- `POST /queue/add` accepts URL-encoded render parameters and queues one job.

For storyboard video:

- Use `mode=i2v` when an uploaded still path is available.
- Use `mode=t2v` only when no still exists.
- Keep `steps >= 8` for standard Q4 renders.
- Useful draft defaults: `quality=draft`, `width=640`, `height=352`, `frames=121`, `steps=8`, `seed=-1`.
- Send `preset_label` with the movie/minute/shot label so Phosphene history remains readable.
