// All settings come from environment variables. See .env.example.
const env = process.env;
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());

const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  // Set when running behind a proxy/load balancer (Render, Railway, Fly, Cloudflare) so rate limits see real IPs.
  trustProxy: bool(env.TRUST_PROXY),
  // Bearer token for /admin endpoints and the /mod panel. Admin is disabled when empty.
  adminToken: env.ADMIN_TOKEN || '',
  // Where event logs, proofs, the leaderboard and mod settings are written. Put this on a persistent disk.
  logDir: env.LOG_DIR || 'var',
  // The event log is cut into chunks of this length; each chunk starts with a checkpoint and is hashed into the proof chain.
  chunkMinutes: num(env.CHUNK_MINUTES, 60),
  // Timestamp each sealed chunk into Bitcoin via the free OpenTimestamps calendars.
  ots: env.OTS === undefined ? true : bool(env.OTS),
  blocklistFile: env.BLOCKLIST_FILE || 'config/blocklist.txt',
  // Comma-separated list of allowed page origins for the live connection, e.g. https://worm.example.com
  allowedOrigins,
  // Absolute site URL used in link previews. Defaults to the first allowed origin.
  publicUrl: (env.PUBLIC_URL || allowedOrigins[0] || '').replace(/\/+$/, ''),

  // $WORM on Solana (pump.fun). Once the mint is known (set here, or by confirming the launch
  // on /launch), live trades reach the worm as logged stimuli.
  token: {
    mint: (env.TOKEN_MINT || '').trim(),
    bigBuySol: num(env.BIG_BUY_SOL, 1),          // a buy this big also flashes light across the eyes
    tradesPerSecond: num(env.TRADES_PER_SEC, 0.7), // at most this many trades become pokes; the rest are counted
    txUrl: env.TX_URL || 'https://solscan.io/tx/',
    solanaRpc: env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
    // live trades: free from a Solana node's log stream by default; PumpPortal if you have a funded API key
    solanaWs: env.SOLANA_WS || 'wss://api.mainnet-beta.solana.com',
    pumpportalKey: env.PUMPPORTAL_API_KEY || '',
    // the launch's image and metadata go to IPFS through Pinata when this is set, else pump.fun's own uploader
    pinataJwt: env.PINATA_JWT || '',
    // SPAWN trades through Jupiter's free API unless this is set (a paid key also routes through less-traded middle tokens)
    jupiterKey: env.JUPITER_API_KEY || '',
  },

  // SPAWN, the launchpad
  spawn: {
    // SPAWN's rewards wallet (a public address): every coin launched on SPAWN names it as its pump.fun creator, so every
    // coin's creator rewards collect there. Not the wallet that launches $WORM. It can also be set once on /launch.
    owner: (env.SPAWN_OWNER || '').trim(),
    // coin pictures and metadata go to IPFS through PINATA_JWT; they are served from LOG_DIR only when it is set on
    // purpose (a persistent disk) or SPAWN_LOCAL_META=1 says so: a coin's metadata address can never change
    localMeta: !!env.LOG_DIR || bool(env.SPAWN_LOCAL_META),
  },

  // the lab: registered experiments against randomly rewired worms, run once in a worker and cached (LAB=0 turns it off)
  lab: env.LAB !== '0',

  // Optional Twitch chat bridge: "!worm <message>" and "!poke" in this channel's chat reach the worm.
  twitch: { channel: (env.TWITCH_CHANNEL || '').trim(), sayPrefix: env.TWITCH_PREFIX || '!worm' },

  // Before a browser may send anything it solves a small proof-of-work puzzle (about 0.1 s on a laptop).
  // Real visitors never notice; a bot farm pays it for every connection. It gets harder under load.
  pow: { bits: num(env.POW_BITS, 16) },

  limits: {
    // per connection (one browser tab)
    messagesPerMinute: num(env.MSG_PER_MIN, 12),
    pokesPerSecond: num(env.POKES_PER_SEC, 3),
    // per address: looser, because phones on the same carrier often share one address
    messagesPerMinutePerIp: num(env.MSG_PER_MIN_IP, 60),
    pokesPerSecondPerIp: num(env.POKES_PER_SEC_IP, 10),
    // across everyone, so a crowd can't keep the worm permanently poked
    pokesPerSecondGlobal: num(env.POKES_PER_SEC_GLOBAL, 20),
    tugsPerHourPerIp: num(env.TUGS_PER_HOUR_IP, 20),
    lampsPerHourPerIp: num(env.LAMPS_PER_HOUR_IP, 12),
    messagesPerSecondGlobal: num(env.MSG_PER_SEC_GLOBAL, 4),
    connectionsPerMinutePerIp: num(env.CONN_PER_MIN_IP, 40),
    maxQueue: num(env.MAX_QUEUE, 12),
    maxTugsQueued: num(env.MAX_TUGS_QUEUED, 1),
    maxLampsQueued: num(env.MAX_LAMPS_QUEUED, 1),
    maxConnectionsPerIp: num(env.MAX_CONN_PER_IP, 24),
    feedSize: num(env.FEED_SIZE, 60),
    boardSize: num(env.BOARD_SIZE, 10),
  },

  // Optional header links shown on the page. Leave empty to hide.
  site: {
    title: env.SITE_TITLE || 'BRAINWORM',
    ticker: env.SITE_TICKER || '',
    contract: env.SITE_CONTRACT || '',
    chain: env.SITE_CHAIN || '',           // e.g. "Solana", shown next to the contract
    // "Label|https://url,Label|https://url"
    links: (env.SITE_LINKS || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
      const [label, url] = pair.split('|').map((s) => (s || '').trim());
      return /^https:\/\//.test(url || '') ? { label, url } : null;
    }).filter(Boolean),
  },
};
