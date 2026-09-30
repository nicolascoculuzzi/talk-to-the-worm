# BRAINWORM

A live website running the published wiring diagram of a three-day-old marine worm larva (*Platynereis dumerilii*): 2,675 cells and cell fragments, 14,066 connections, 26,881 synapses. **There is one worm and everyone on the site sees it.** Visitors type messages that scroll past its eyes as light, poke it, or set two words against each other in a tug, and watch the activity spread through its real wiring in 3D, and its simulated body swim through a virtual tank.

Everything is checkable. Every browser runs its own copy of the worm and compares its state hash with the server's every second; any hour of the log can be replayed in the browser or from a terminal; each sealed hour is hash-chained and timestamped into Bitcoin.

## Run it locally

```bash
npm install
ADMIN_TOKEN=pick-a-long-secret npm start     # http://localhost:3000, /mod, /launch, /stream
npm test                                      # all tests
```

Node 20 or newer.

## What's on the site

- **The worm in 3D** (WebGL2, bloom, depth of field): every drawn cell at its published position, connections lighting up when their sending cell fires, sparks running sender → receiver, hover any cell to trace its real inputs and outputs, anatomy labels, a camera that follows what's happening, and a scroll story that flies to the eyes, the nerve cord and the muscles.
- **The lamp** (`shared/lamp.js`): anyone can light a lamp in the tank for 30 s. Each side's eyes see it depending on which way the body faces, so the swim feeds back into the brain: a closed loop. Its lab test (`follow-the-light`, registered and hashed before any lamp was lit) failed under model v1 (it stayed ~42 µm *farther* from the lamp) and passes under model v2, by a small margin: ~15 µm closer on average than with the lamp dark, above 96% of the rewired worms.
- **Talk / poke / tug.** Tugs show word A to one half of the view and word B to the other in five passes (warm-up, then A|B, B|A, B|A, A|B), so each word is scored on each side equally often and the model's own left lean cancels. A calibration runs on a fresh worm at every start and is published (same word on both sides ≈ 0; swapping words flips the sign).
- **The body:** the worm's own activity drives a simulated swimming body in a virtual tank (`shared/body.js`). Its ciliary bands push it forward in a helix, input to a ciliated cell stops it beating (one side: it turns; everywhere: it sinks), body-wall muscles steer, startle muscles brake. Live 3D tank with the last minute of its path, speed, depth, cilia and distance; every message reports how far it swam, how far its brain turned it and how long its cilia stopped. The body is part of the logged, hashed state, so the live check and replays cover it.
- **Break the worm:** today's and all-time most cells firing at once. Only undisturbed runs are ranked.
- **The lab** (`shared/lab.js`, `/lab.json`, `npm run lab`): registered experiments, each rule frozen and hashed before the first run, against 50 degree-preserving random rewirings. Results, stated plainly. Model v1 (retired, `data/lab-model-v1.json`): 0 of 4 pass/fail tests passed. Model v2, first and only run (`data/lab-model-v2-first-run.json`): 3 pass (light on one side reaches that side; one eyespot stops the cilia on its own side; it swims toward the lamp, by a small 15 µm on average), 3 fail (touch reaching the startle muscles, both versions; the startle reflex, whose cilia half works but whose muscle half doesn't), 4 measured. Measured: light takes 7 steps (233 ms of model time) to reach a muscle (rewired: 3.7 steps on average), "@" fires the most cells (41 at once; the ranking follows lit pixels), a repeatedly poked spot fires 0.88 as many cells by the tenth poke (the model's fatigue), and the MC rhythm stops at most 15% of the ciliated cells at once. Reproducible bit for bit: same results SHA-256 in Node and Bun. The server computes it once in a worker and caches it (`LAB=0` turns it off).
- **Sound** (every firing cell clicks), **clips** (8-second square MP4/WebM rendered in the browser, message burned in), **share**.
- **Proof:** live check badge, in-browser replay, the log as it's written, the hourly proof chain with Bitcoin timestamps, and a manifest of every number the model uses (measured or chosen).
- **/stream** 16:9 layout for OBS, with an optional Twitch chat bridge (`!worm message`, `!poke`).
- **/mod** phone-friendly moderation: pause chat or pokes, slow mode, hide, mute, announcements, blocklist.
- **SPAWN, the launchpad** (the launch card on the main page, and `/spawn`): anyone can launch a pump.fun coin there, on pump.fun's bonding curve, with pump.fun's fees and its graduation to PumpSwap when the curve sells out. Launching is free apart from about 0.02 SOL of rent for the coin's accounts and an optional first buy in the same transaction, which the launcher's own wallet signs and sends. Every coin names SPAWN's rewards wallet as its pump.fun creator, so its creator rewards (on the curve, and on PumpSwap after graduation) go to SPAWN, not to its launcher: 64% of everything SPAWN collects buys $WORM and all of that $WORM is burned, each purchase and burn a public transaction; the other 36% stays with the team. Every coin hatches its own worm, a fresh copy of the larva whose first sight is "$TICKER" and which then feels every trade of the coin (a buy touches its head end, a sell its tail end), rebuildable in any browser; every buy also pokes the live worm at the coin's own spot. Each coin has its page at `/c/<mint>` with its chart, buy and sell, its worm and a share link.
- **/launch** the $WORM launch (below), and the owner's SPAWN controls.

## Deploy

It needs a host that runs one long-lived Node process with WebSockets (Railway, Render, Fly, a VPS). Serverless won't work. Run **exactly one instance**: the worm lives in the server's memory. Put `LOG_DIR` on a persistent disk so logs, proofs, the leaderboard, mod settings and the launch state survive restarts.

Load test (2,000 simultaneous viewers with constant messages and pokes, one process): real time held at 30.0 steps/s, ~9 KB/s per viewer, ~21% of one CPU core. `node scripts/loadtest.js <url> <viewers> <seconds>`.

## Settings

All optional, as environment variables (see `.env.example`): `PORT`, `TRUST_PROXY`, `ADMIN_TOKEN`, `ALLOWED_ORIGINS`, `PUBLIC_URL`, `LOG_DIR`, `CHUNK_MINUTES`, `OTS`, `TOKEN_MINT`, `BIG_BUY_SOL`, `TRADES_PER_SEC`, `TX_URL`, `SOLANA_RPC`, `SOLANA_WS`, `PUMPPORTAL_API_KEY`, `PINATA_JWT`, `SPAWN_OWNER`, `SPAWN_LOCAL_META`, `JUPITER_API_KEY`, `POW_BITS`, `SITE_TICKER`, `SITE_CONTRACT`, `SITE_CHAIN`, `SITE_LINKS`, `TWITCH_CHANNEL`, `TWITCH_PREFIX`, and the rate limits.

## Checking it's real

- **Live:** every visitor's browser downloads the worm's exact state, runs the same code (`/shared/`), applies every stimulus at the step it happened, and compares SHA-256 state hashes with the server once a second. The simulation uses only arithmetic that every JavaScript engine computes identically (`shared/detmath.js`), so Chrome, Safari and Firefox all match the server bit for bit.
- **Replay:** `npm run replay -- https://yoursite/log/current.jsonl`, or the "Replay this hour" button.
- **Proof chain:** each hour's log ends with the hash of the state it left; the next hour starts from that exact state. Each hour's proof file names the log's SHA-256 and the previous proof's SHA-256, and is timestamped via OpenTimestamps (`/proof.json`, `/proof/<file>.txt`, `.ots`).
- **Open data:** `/manifest.json`, `/board.json`, `/proof.json`, `/log/index.json`, `/log/<file>` are public with open CORS.

## $WORM launch (ready, not launched)

The project's own coin is named BRAINWORM, ticker $WORM, created on pump.fun.

1. A mod arms the launch on `/launch`. The first time a touch makes the worm stop swimming after that (its cilia stop, outside its own stop-and-go rhythm) is the launch moment; the arming and the moment go into the log, and a replay confirms the moment was the first stop after arming and matches the logged state hash.
2. The token image is rendered from the worm's exact activity at that step (`server/render.js`).
3. On the owner's click, the image and metadata go to IPFS (through Pinata if `PINATA_JWT` is set, otherwise pump.fun's own uploader, which PumpPortal's docs now say is being retired).
4. The server prepares the pump.fun create transaction (PumpPortal) with a fresh mint key signed in; the owner's wallet (Phantom, Solflare… via Wallet Standard) adds its signature and sends it. The server never holds the owner's key.
5. When it confirms, the mint becomes the site's contract and trades reach the worm: buys poke the head end, sells the tail end, big buys flash light, each logged with its signature.

$WORM's own pump.fun creator rewards stay with the team. Launch it from a different wallet than SPAWN's rewards wallet, so the two sets of creator rewards stay apart.

## Chat safety and bots

- Links and wallet/contract addresses are refused in chat, tugs and announcements, so nobody can post a fake contract; profanity is starred; `config/blocklist.txt` plus mod-added phrases; mutes by hashed address.
- **Proof-of-work:** before a browser may send anything it solves a small SHA-256 puzzle in a background thread (`POW_BITS`, ~0.1 s at 16 bits on a laptop). Visitors never notice; a bot farm pays it for every connection, and it gets 4–16× harder automatically when new connections spike.
- **Rate limits** per tab, per address (messages, pokes, tugs, new connections per minute) and globally (messages per second, pokes per second), plus a cap on open connections per address.
- Everyone's pokes appear on everyone's screen with who made them, and the activity panel shows pokes and messages per minute.

## What is real and what is simplified

- **Real:** every cell, connection and synapse count comes from the published connectome. 1,199 cells are drawn at soma positions from the lab's 3D cell-type reconstructions; 1,009 without a published position are placed in their correct segment and side; 467 fragments are simulated but not drawn.
- **Simplified (model v2, `shared/model.js`):** each cell is a firing-rate unit; a connection's strength is its synapse count times one number set by a rule (1 / the synapse matrix's largest eigenvalue, so no loop can amplify itself); the transmitter is known for 79 of 2,675 cells, so almost every synapse is excitatory; cholinergic input stops the cilia and serotonergic keeps them beating (Verasztó et al. 2017, Jékely et al. 2008); the MC cell's stop-and-go rhythm every 71 s; slow per-cell fatigue. Nothing is trained. Model v2 and its new tests were registered, fingerprinted and timestamped into Bitcoin before their first run (`data/registrations/model-v2.json`).
- **Chosen:** how the message maps onto the 26 eye photoreceptors, that the 4 non-directional light sensors only respond to a mostly bright view, which cells a poke activates, how trades map to pokes, how activity is drawn and sounded, and the swimming physics and tank (every number is in `/manifest.json`). The body doesn't feed back into the brain.

## Data and licence

Wiring data: Verasztó C, Jasek S, Gühmann M, Bezares-Calderón LA, Williams EA, Shahidi R, Jékely G. *Whole-body connectome of a segmented annelid larva.* eLife (2025). https://elifesciences.org/articles/97964 · https://github.com/JekelyLab/Platynereis_3D_connectome_2024 · licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes: positions and cell shapes derived from the lab's 3D viewer files, re-encoded for the browser, simulation and body added. Not affiliated with or endorsed by the authors.

Rebuild `data/wiring.json` from the source repository (reproduces the committed file byte-for-byte):

```bash
git clone --depth 1 https://github.com/JekelyLab/Platynereis_3D_connectome_2024 plat
pip install numpy
python3 scripts/build-data/build_wiring.py plat data/wiring.json
```

Pixel font: rasterised from Poppins Bold (SIL Open Font License) by `scripts/build-data/make_glyphs.py`.
