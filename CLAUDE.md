# BRAINWORM

One live simulation of a real marine worm larva's nervous system (the published *Platynereis dumerilii* whole-body connectome), driving a simulated swimming body in a virtual tank. The server runs the only worm; every visitor sees the same activity, and anyone can send it a message (shown to its eyes as light), poke it, or run a tug (two words, one per eye). Every browser re-runs the worm itself and checks the server's state hash every second.

## Commands

- `npm install` then `npm start` → http://localhost:3000 (`ADMIN_TOKEN=... npm start` enables `/mod` and `/launch`)
- `npm run dev` → restart on file changes
- `npm test` → unit tests, a multi-viewer server test with a live mirror, replays of every log chunk, launch-moment checks. Run before every commit.
- `npm run replay -- <events.jsonl | https://site/log/current.jsonl>` → re-run a log and check every published result.
- `node scripts/make-og.js` → regenerate `public/og.png` and the touch icon.

## Layout

- `shared/` runs in Node **and** the browser (served at `/shared/`). No Node or DOM APIs here.
  - `model.js` model v2 as registered (pinned by `test/model.test.js`). `sim.js` runs it: strength = synapse count × `PARAMS.strength` (1 / the synapse matrix's largest eigenvalue), serotonergic synapses onto the cholinergic ciliomotor cells inhibitory. Uses `detmath.js` `tanh` (plain arithmetic, identical in every JS engine). `cilia.js` the cilia rule (cholinergic input stops a ciliated cell, serotonergic keeps it beating). `data.js` attaches `data/transmitters.json` to the wiring: every loader needs both files.
  - `worm.js` `WormCore`: sim + body + message/tug queue + pokes + per-stimulus summaries + snapshot/restore. Pure and deterministic.
  - `lamp.js` the lamp: where it is and which way the body faces set how much light each side's eyes get (a closed loop). `LAMP` numbers are registered in the lab's follow-the-light protocol; changing them fails the lab.
  - `body.js` the swimming body: cilia push and spin it, arrests turn it or let it sink, muscles steer, startle brakes, a spherical tank. `BODY` numbers are ours and listed in the manifest. Part of the hashed state.
  - `text.js` + `glyphs.js` message → pixel columns → photoreceptor input (also split-view input for tugs).
  - `roles.js` which cells are eyes, touch sensors, muscles, cilia; readout maths.
  - `lab.js` registered experiments against rewired worms (frozen protocols, hashed; add new ones, never edit old ones).
  - `coinworm.js` a SPAWN coin's own worm: a fresh copy of the larva shown "$TICKER" at birth, then fed only its coin's trades (buy → head-end touch cells, sell → tail-end, picked from the signature; 60 steps each; time stands still between trades). A pure function of ticker + trade list, so `rebuild()` in any browser matches the server's hash. Changing what it does means bumping `COINWORM_VERSION`.
  - `frames.js` the binary activity stream (sparse or dense, with the body's pose). `state.js` snapshot JSON. `replay.js` log replay. `mirror.js` the live mirror.
- `server/server.js` http + WebSocket `/live`, 30 steps/s loop, 15 fps frames, feed, limits, admin API, live-verification syncs, clock.
  - `ledger.js` hourly log chunks with checkpoints, the proof hash chain, OpenTimestamps (`ots.js`).
  - `board.js` leaderboard + recent tugs. `modstate.js` pause/slow/mutes/announcements. `names.js` handles. `static.js` compressed static files.
  - `launch.js` the $BRAINWORM launch (arm → moment → metadata → owner-signed transaction → confirmed). Set `TOKEN_MINT` after it confirms: without a disk, LOG_DIR forgets the launch on every deploy. `solana.js` Solana/pump.fun/PumpPortal. `render.js` deterministic PNG of an activity state.
  - `spawn.js` SPAWN, the launchpad (the site's main feature: the Launch tab on the main page's dock, and `/spawn`): coins on Meteora Dynamic Bonding Curves, priced in SOL until $BRAINWORM exists and the owner makes a config for it, then in $BRAINWORM (older coins keep their config). 1% fee in the coin's quote token (Meteora 20%, creator 20% of the rest, the rest to $BRAINWORM's burn: fees in $BRAINWORM are claimed and burned by the owner; fees in SOL wait in their pools until $BRAINWORM exists, then are claimed into the owner's wrapped SOL, swapped for $BRAINWORM through Jupiter, and exactly what that bought is burned; each burn read back from the chain). A coin priced in SOL trades on its own curve in SOL (wrapped and unwrapped in the same transaction). For one priced in $BRAINWORM, buying with SOL is one Jupiter transaction when Jupiter routes through $BRAINWORM, else two (Jupiter SOL → $BRAINWORM, then the coin's own curve); paying with $BRAINWORM is one, on the curve. A buy pokes the worm at the coin's own spot. Opens once the owner makes a config on `/launch` and coin pictures can be hosted (`PINATA_JWT`, or `LOG_DIR`/`SPAWN_LOCAL_META=1` on a lasting disk). With `SPAWN_OWNER` (the owner's wallet address) it needs no saved state: configs are found on the chain, pictures in coins' metadata, burns in the owner's transactions. Meteora's migrator graduates coins to DAMM v2, whose fees go to two locked positions, the creator's and the owner's; the owner's are claimed, then burned (or bought back first, for SOL). `launchform.js` and `coincard.js` in `public/` are the launch form and coin card both pages share. `dbc.js` the Meteora program without an SDK: curve maths (buys and sells to the atom), instructions, legacy transactions, account and event decoding (`test/dbc.test.js` checks it against mainnet data). Jupiter's free API refuses `restrictIntermediateTokens=false`; only send it with `JUPITER_API_KEY`.
  - `coinworms.js` keeps every coin's worm: one record per coin in `<LOG_DIR>/spawn/worms/`, hatched when the coin is listed, fed live trades, caught up from the chain after a restart, served at `/spawn/worm/<mint>.json|.png|-birth.png`; `/spawn/hatch/<TICKER>.png` previews a first sight.
  - `scripts/make-spawn-art.js` SPAWN's logo (`public/spawn-logo.svg`, `spawn-icon.png`) and link preview (`spawn-og.png`).
  - `lab.js` + `lab-worker.js` run the lab once in a worker, cache it in `<LOG_DIR>/lab-results.json`, serve `/lab.json`.
  - `twitch.js` optional Twitch chat bridge. `moderation.js` link/address/blocklist rejection, profanity, token buckets.
- `public/` the page: `index.html`, `style.css`, `app.js` (+ `gl.js` WebGL renderer, `render2d.js` fallback, `tank.js` the swim view, `morph.js` cell shapes, `sound.js`, `clip.js`, `pixel.js`, `sha256.js` proof-of-work, `verify-worker.js`), `/mod` panel, `/launch` page, `/stream` layout, `/spawn` (`spawn.html`, `spawn.js`, `coinworm-worker.js` which rebuilds a coin's worm to check it), `wallet.js` (Wallet Standard: the visitor's own wallet signs and sends).
- `data/wiring.json` generated by `scripts/build-data/build_wiring.py` from the lab's repo. Do not hand-edit. `data/transmitters.json` by `scripts/build-data/build_transmitters.py`. `data/registrations/` holds each registration record and its OpenTimestamps proof; `data/lab-model-v1.json` the retired model's results. `data/morph.bin` (cell shapes + body outline) is generated by `scripts/build-data/build_morph.py`.

## Protocol (`/live`)

Client → server: `{t:'say', text}`, `{t:'tug', a, b}`, `{t:'poke', cells}`, `{t:'lamp'}`, `{t:'verify'}`.
Server → client JSON: `hello`, `queued`, `tugqueued`, `lampqueued`, `start`, `poke`, `tugresult`, `done`, `watchers`, `hide`, `feed`, `board`, `record`, `mod`, `proof`, `launch`, `clock`, `state` (after verify), `sync` (state hash each second, to verifiers), `error`.
Server → client binary frame: see `shared/frames.js`.

## Rules

1. **Honesty is the product.** Never change the wiring or add connections. A connection's strength is its synapse count times the one number the registered model sets; the only signs are the ones a registered model rule reads from the lab's transmitter data. The model (`shared/model.js`) and every lab protocol are registered, fingerprinted and timestamped before they are first run, and never edited afterwards: a change is a new version, and every version's results stay published. Anything that changes how the model behaves must also update the copy in `public/index.html` ("How it works", "Stated plainly") and the manifest in `server/server.js`. Don't write copy that claims the worm reads, understands, predicts prices, chooses, or launched anything by itself.
2. **Keep `shared/` deterministic, in every engine.** No `Math.random`, `Date`, timers, I/O, and no `Math.exp/tanh/pow/sin/...` in the simulation path (use `detmath.js`; only + − × ÷ and exact functions). If you change results, bump `LOG_VERSION` in `shared/replay.js`. The live mirror test must stay green.
3. **One process.** The worm lives in server memory. Never run more than one instance.
4. **Keep the scam filters.** Chat and announcements never accept links or wallet/contract addresses. The only contracts shown are the configured or confirmed $BRAINWORM mint and, on `/spawn`, coins on SPAWN's own configs (read from the chain; a coin made there some other way is listed only if its name passes the chat filter).
5. **Never hold the owner's keys.** The server may generate and discard a fresh mint or config key for a transaction it prepares; it never stores, receives or uses the owner's (or anyone's) wallet key, and never sends a transaction itself.
6. **Keep the attribution.** The data is CC BY 4.0 (Verasztó et al., eLife 2025, Jékely lab). The footer credit and "not affiliated" line stay.
7. No build step and no frontend framework. Plain ES modules. Keep dependencies minimal (`ws`, `obscenity`).
