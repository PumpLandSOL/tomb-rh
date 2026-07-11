// TOMB — a single-token algorithmic peg + seigniorage protocol on Robinhood Chain (EVM).
//   $TOMB is the ONLY token you launch. It targets a 1 ETH peg.
//   Above peg  -> the protocol expands; the new TOMB is paid to TOMB stakers in the Mausoleum.
//   Bonds      -> deposit real ETH or USDC for discounted, vesting TOMB; the deposit grows the treasury.
//   Treasury   -> ETH + USDC reserves that back every TOMB.
// No share token, no bond token — the only "other coins" are ETH and USDC, which already exist.
// Off-chain ledger model (compatible with a plain ERC-20 on Robinhood Chain; payout via scripted airdrop).
// Dependency-free: Node http + fs only.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8142;
const ROOT = path.join(__dirname, '..');
const DATA_PATH = process.env.DATA_PATH || path.join(ROOT, 'data.json');

const TOKEN = 'TOMB';
const TOMB_MINT = process.env.TOMB_MINT || '';  // $TOMB ERC-20 CA on Robinhood Chain (CA bar, dormant until set)
const EPOCH_SEC = +(process.env.EPOCH_SEC || 600);              // seigniorage epoch (demo: 10 min; real Tomb = 6h)
const ETH_PRICE = +(process.env.ETH_PRICE || 1800);            // $ per ETH (until a real oracle is wired)
const MAX_EXPANSION = +(process.env.MAX_EXPANSION || 0.04);    // max supply expansion / epoch (Tomb default 4%)
const BOARD_ALLOC = 0.85;                                       // share of expansion paid to stakers (rest -> treasury)
const SEED_BALANCE = +(process.env.SEED_BALANCE || 1000);      // demo: new wallet starts with this TOMB so it can stake
const EPOCHS_YR = 31557600 / EPOCH_SEC;
const SCALE = 1e12;
const APR_CADENCE = 1460, APR_CAP = 99999;                     // annualize on a 6h cadence + authentic Tomb-era ceiling

// bond markets — real assets, nothing to deploy
const BONDS = [
  { id: 'eth', name: 'ETH', discount: 0.07, vestDays: 5 },
  { id: 'usdc', name: 'USDC', discount: 0.05, vestDays: 5 },
];
const bondUsd = (m, amt) => m === 'eth' ? amt * ETH_PRICE : amt;   // input is in the asset's own units

// ---------- state ----------
let db = {
  epoch: 0, lastEpoch: Date.now(), twap: 1.045,
  tombSupply: +(process.env.TOMB_SUPPLY || 1e6),
  treasury: +(process.env.TREASURY_SEED || 120000),   // USD value of ETH + USDC reserves
  bAcc: 0, bStakedTotal: 0,                            // boardroom: accumulated TOMB per staked TOMB
  lastExpansionRate: 0, lastExpansionTomb: 0,
  hist: [], wallets: {},
};
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))); } catch (e) {}
if (!db.wallets) db.wallets = {};
if (!db.hist) db.hist = [];

let saveT = null;
function save() { if (saveT) return; saveT = setTimeout(() => { saveT = null; try { fs.writeFileSync(DATA_PATH, JSON.stringify(db)); } catch (e) {} }, 800); }
const isWallet = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
function W(a) { return db.wallets[a] || (db.wallets[a] = { tomb: SEED_BALANCE, bStaked: 0, bDebt: 0, bonds: [], seeded: true }); }
const tombUsd = () => db.twap * ETH_PRICE;
const bPending = (w) => Math.max(0, (w.bStaked * db.bAcc) / SCALE - w.bDebt);

// ---------- seigniorage epoch ----------
function runEpoch() {
  // simulated TWAP: mean-reverting random walk around the 1.0 ETH peg (slight bullish bias)
  db.twap += (1.0 - db.twap) * 0.26 + (Math.random() - 0.45) * 0.05;
  db.twap = Math.max(0.85, Math.min(1.25, db.twap));
  let rate = 0, toBoard = 0;
  if (db.twap >= 1.01 && db.bStakedTotal > 0) {
    rate = Math.min(MAX_EXPANSION, db.twap - 1);            // expansion scales with premium, capped
    const newTomb = db.tombSupply * rate;
    toBoard = newTomb * BOARD_ALLOC;
    db.tombSupply += newTomb;
    db.bAcc += (toBoard * SCALE) / db.bStakedTotal;          // distribute to TOMB stakers
    db.treasury += newTomb * (1 - BOARD_ALLOC) * tombUsd();
  }
  db.epoch++; db.lastEpoch = Date.now();
  db.lastExpansionRate = rate; db.lastExpansionTomb = toBoard;
  db.hist.push(+db.twap.toFixed(4)); if (db.hist.length > 48) db.hist.shift();
  save();
}
(function catchup() { const missed = Math.floor((Date.now() - db.lastEpoch) / 1000 / EPOCH_SEC); for (let i = 0; i < Math.min(missed, 2000); i++) runEpoch(); })();

// effective bond discount — sweetens when below peg (incentivizes buy pressure)
function bondDiscount(m) { const below = db.twap < 1 ? (1 - db.twap) * 0.5 : 0; return Math.min(0.35, m.discount + below); }

// ---------- views ----------
function metrics() {
  const projEmission = db.tombSupply * MAX_EXPANSION * BOARD_ALLOC * 0.55;  // duty-cycled (~55% of epochs expand)
  const stakedUsd = db.bStakedTotal * tombUsd();
  const denom = Math.max(stakedUsd, db.tombSupply * 0.4 * tombUsd());        // floor base so genesis APR stays sane
  const apr = Math.min(APR_CAP, (projEmission * tombUsd()) / denom * APR_CADENCE * 100);
  const above = db.twap >= 1.01;
  const backing = db.treasury / db.tombSupply;                              // $ backing per TOMB
  const rewardsPerDayUsd = projEmission * tombUsd() * (86400 / EPOCH_SEC) * 0.55;
  return {
    token: TOKEN, mint: TOMB_MINT, network: 'robinhood-chain',
    epoch: db.epoch, epochSec: EPOCH_SEC,
    nextEpochIn: Math.max(0, EPOCH_SEC - (Date.now() - db.lastEpoch) / 1000),
    twap: +db.twap.toFixed(4), pegTargetEth: 1.0, pegStatus: above ? 'above' : (db.twap >= 1 ? 'at' : 'below'),
    expansionRate: db.lastExpansionRate, maxExpansion: MAX_EXPANSION,
    tomb: { priceUsd: tombUsd(), priceSol: +db.twap.toFixed(4), supply: db.tombSupply, marketCap: tombUsd() * db.tombSupply, backingUsd: backing },
    treasury: db.treasury, ethPrice: ETH_PRICE,
    tvl: db.treasury + stakedUsd,
    boardroom: { totalStaked: db.bStakedTotal, stakedUsd, apr, tombPerEpoch: projEmission },
    runwayDays: rewardsPerDayUsd > 0 ? db.treasury / rewardsPerDayUsd : 0,
    bonds: BONDS.map((m) => ({ id: m.id, name: m.name, discount: bondDiscount(m), vestDays: m.vestDays, priceUsd: tombUsd() * (1 - bondDiscount(m)) })),
    hist: db.hist,
  };
}
function account(addr) {
  const w = W(addr); const now = Date.now();
  const bonds = w.bonds.filter((b) => !b.done).map((b) => {
    const pct = Math.max(0, Math.min(1, (now - b.start) / (b.end - b.start)));
    return { market: b.market, payout: b.payout, claimable: Math.max(0, b.payout * pct - b.claimed), pct, endsIn: Math.max(0, (b.end - now) / 1000) };
  });
  return { wallet: addr, tomb: w.tomb, staked: w.bStaked, earned: bPending(w), bonds, seeded: !!w.seeded };
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
function serve(req, res) { let u = decodeURIComponent(req.url.split('?')[0]); if (u === '/') u = '/client/index.html'; const f = path.normalize(path.join(ROOT, u)); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); } fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(b); }); }
function json(res, c, o) { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch (e) { r({}); } }); }); }
const num = (v, hi) => { let n = +v; if (!isFinite(n) || n <= 0) return 0; return hi != null ? Math.min(n, hi) : n; };

http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/config') return json(res, 200, { token: TOKEN, mint: TOMB_MINT, epochSec: EPOCH_SEC, network: 'robinhood-chain' });
  if (u === '/api/metrics') return json(res, 200, metrics());

  if (req.method === 'POST') {
    const d = await body(req);
    if (u === '/api/account') { if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a valid EVM wallet' }); return json(res, 200, account(d.wallet)); }
    if (!isWallet(d.wallet || '')) return json(res, 200, { error: 'connect a wallet first' });
    const w = W(d.wallet);

    if (u === '/api/stake') { const amt = num(d.amount, w.tomb); if (!amt) return json(res, 200, { error: 'nothing to stake' }); const pend = bPending(w); if (pend > 0) w.tomb += pend; w.tomb -= amt; w.bStaked += amt; db.bStakedTotal += amt; w.bDebt = (w.bStaked * db.bAcc) / SCALE; save(); return json(res, 200, { ok: true, ...account(d.wallet) }); }
    if (u === '/api/unstake') { const amt = num(d.amount, w.bStaked); if (!amt) return json(res, 200, { error: 'nothing staked' }); const pend = bPending(w); if (pend > 0) w.tomb += pend; w.bStaked -= amt; db.bStakedTotal = Math.max(0, db.bStakedTotal - amt); w.tomb += amt; w.bDebt = (w.bStaked * db.bAcc) / SCALE; save(); return json(res, 200, { ok: true, ...account(d.wallet) }); }
    if (u === '/api/claim') { const pend = bPending(w); if (pend <= 0) return json(res, 200, { error: 'no rewards yet' }); w.tomb += pend; w.bDebt = (w.bStaked * db.bAcc) / SCALE; save(); return json(res, 200, { ok: true, claimed: pend, ...account(d.wallet) }); }

    if (u === '/api/bond') {
      const m = BONDS.find((x) => x.id === d.market); if (!m) return json(res, 200, { error: 'bad market' });
      const amt = num(d.amount); if (!amt) return json(res, 200, { error: 'enter an amount' });
      const usd = bondUsd(m.id, amt);
      const payout = usd / (tombUsd() * (1 - bondDiscount(m)));      // discounted TOMB
      const now = Date.now();
      w.bonds.push({ market: m.name, payout, start: now, end: now + m.vestDays * 86400000, claimed: 0, done: false });
      db.treasury += usd; db.tombSupply += payout; save();
      return json(res, 200, { ok: true, payout, ...account(d.wallet) });
    }
    if (u === '/api/bond/claim') {
      const now = Date.now(); let claimed = 0; const autostake = !!d.autostake;
      for (const b of w.bonds) { if (b.done) continue; const pct = Math.max(0, Math.min(1, (now - b.start) / (b.end - b.start))); const c = b.payout * pct - b.claimed; if (c > 0) { b.claimed += c; claimed += c; if (pct >= 1) b.done = true; } }
      if (claimed > 0) { if (autostake) { const pend = bPending(w); if (pend > 0) w.tomb += pend; w.bStaked += claimed; db.bStakedTotal += claimed; w.bDebt = (w.bStaked * db.bAcc) / SCALE; } else w.tomb += claimed; save(); }
      return json(res, 200, { ok: true, claimed, autostake, ...account(d.wallet) });
    }
  }
  serve(req, res);
}).listen(PORT, () => console.log('TOMB ($' + TOKEN + ') on :' + PORT + ' — peg 1 ETH, epoch ' + EPOCH_SEC + 's'));

setInterval(() => { if (Date.now() - db.lastEpoch >= EPOCH_SEC * 1000) runEpoch(); }, 1000);
