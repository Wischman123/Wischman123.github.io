# showcase_site — no hand-written HTML lives here

- Pages are rendered from `.j2` templates in the PHYSICS repo; `src/` + `tools/` are a generated, hash-defended mirror (`MIRROR.json`) — edit the source there and re-run `build_and_publish.py`, never edit the mirror.
- Every displayed number comes from the committed `src/data/showcase_data.json` — the JSON is the only stat mover; never hand-type a stat.
- Build + gate: `python build.py --check` (pushing to main deploys via CI). Once per clone: `git config core.hooksPath .githooks`.
