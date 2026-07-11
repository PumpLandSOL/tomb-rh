'use strict';
const $ = (id) => document.getElementById(id);
const api = (u, b) => fetch(u, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined).then((r) => r.json());
const fmt = (n, d = 2) => (n == null || !isFinite(n)) ? '—' : (+n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const usd = (n) => '$' + (Math.abs(n) >= 1e6 ? fmt(n / 1e6, 2) + 'M' : Math.abs(n) >= 1e3 ? fmt(n / 1e3, 1) + 'K' : fmt(n, n < 10 ? 4 : 2));
const cnt = (n) => Math.abs(n) >= 1e6 ? fmt(n / 1e6, 2) + 'M' : Math.abs(n) >= 1e3 ? fmt(n / 1e3, 1) + 'K' : fmt(n, 0);

let M = null, A = null, wallet = localStorage.getItem('tomb_w') || '';
let bondMarket = 'eth';
let nextEpochAt = 0;

function toast(msg, err) { const t = $('toast'); t.textContent = msg; t.className = 'toast on' + (err ? ' err' : ''); clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = 'toast'), 2600); }

// ---------- routing ----------
function go(pg) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.id === 'pg-' + pg));
  document.querySelectorAll('.links a').forEach((a) => a.classList.toggle('on', a.dataset.pg === pg));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
document.addEventListener('click', (e) => { const t = e.target.closest('[data-pg]'); if (t) { e.preventDefault(); go(t.dataset.pg); } });

// ---------- wallet (EVM connect via injected provider) ----------
const isW = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
function setConnected() {
  const b = $('connect');
  if (wallet) { b.textContent = wallet.slice(0, 6) + '…' + wallet.slice(-4); b.classList.add('ghost'); b.title = 'Disconnect'; }
  else { b.textContent = 'Connect Wallet'; b.classList.remove('ghost'); b.title = ''; }
}
async function connectWallet() {
  if (wallet) { wallet = ''; A = null; localStorage.removeItem('tomb_w'); setConnected(); renderAccount(); toast('Wallet disconnected'); return; }
  const eth = window.ethereum;
  if (!eth) return toast('No EVM wallet found — install Rabby or MetaMask', true);
  try {
    const acc = await eth.request({ method: 'eth_requestAccounts' });
    if (acc && acc[0] && isW(acc[0])) { wallet = acc[0]; localStorage.setItem('tomb_w', wallet); setConnected(); toast('Wallet connected (3,3)'); await loadAccount(); }
    else toast('No account returned', true);
  } catch (e) { toast('Connection rejected', true); }
}
$('connect').onclick = connectWallet;
if (window.ethereum && window.ethereum.on) window.ethereum.on('accountsChanged', async (acc) => {
  if (acc && acc[0] && isW(acc[0])) { wallet = acc[0]; localStorage.setItem('tomb_w', wallet); setConnected(); await loadAccount(); }
  else { wallet = ''; A = null; localStorage.removeItem('tomb_w'); setConnected(); renderAccount(); }
});
function needWallet() { if (!wallet) { connectWallet(); return true; } return false; }

// ---------- metrics ----------
async function loadMetrics() { M = await api('/api/metrics'); nextEpochAt = Date.now() + M.nextEpochIn * 1000; renderMetrics(); }
function pegPill(el, status) {
  const above = status === 'above';
  el.className = 'pegpill ' + (above ? 'above' : 'below');
  el.innerHTML = '<span class="dt"></span>' + (above ? 'Above peg' : status === 'at' ? 'At peg' : 'Below peg');
}
function renderMetrics() {
  if (!M) return;
  $('d-epoch').textContent = M.epoch;
  $('d-twap').innerHTML = fmt(M.twap, 3) + '<small> ETH</small>';
  pegPill($('d-peg'), M.pegStatus);
  $('d-tvl').textContent = usd(M.tvl);
  // tomb card
  $('t-tomb').textContent = usd(M.tomb.priceUsd);
  $('t-tombsol').textContent = fmt(M.tomb.priceSol, 3) + ' ETH';
  $('t-tombmc').textContent = usd(M.tomb.marketCap);
  $('t-tombsup').textContent = cnt(M.tomb.supply) + ' TOMB';
  $('t-tombback').textContent = usd(M.tomb.backingUsd);
  // treasury card
  $('t-treas').textContent = usd(M.treasury);
  $('t-runway').textContent = M.runwayDays > 9000 ? '∞' : fmt(M.runwayDays, 0) + ' days';
  // invest
  $('i-maus').textContent = cnt(M.boardroom.apr) + '%';
  $('i-bond').textContent = fmt(Math.max(...M.bonds.map((b) => b.discount)) * 100, 1) + '%';
  // mausoleum page
  $('m-apr').textContent = cnt(M.boardroom.apr) + '%';
  $('m-epoch').textContent = M.epoch;
  $('m-exp').textContent = M.expansionRate > 0 ? '+' + fmt(M.expansionRate * 100, 2) + '% TOMB' : (M.epoch === 0 ? 'awaiting first epoch' : 'none — below peg');
  // CA bar
  if (M.mint) { $('cabar').style.display = 'flex'; $('ca-mint').textContent = M.mint; }
  renderBonds();
}
function renderBonds() {
  const grid = $('bondgrid');
  grid.innerHTML = M.bonds.map((b) => `
    <div class="bond panel" data-bm="${b.id}" style="cursor:pointer;${b.id === bondMarket ? 'border-color:var(--line2);box-shadow:0 0 0 1px var(--line2),0 18px 50px rgba(0,0,0,.45)' : ''}">
      <div class="bt"><div class="ba ${b.id}">${b.id === 'eth' ? 'Ξ' : '$'}</div><div><div class="bn">${b.name} Bond</div><div class="bl">vests ${b.vestDays}d</div></div></div>
      <div class="bd">${fmt(b.discount * 100, 1)}%</div><div class="bl">discount</div>
      <div class="kv"><span>Bond price</span><b>${usd(b.priceUsd)} / TOMB</b></div>
      <div class="kv"><span>Market price</span><b>${usd(M.tomb.priceUsd)}</b></div>
    </div>`).join('');
  syncBondForm();
}
function syncBondForm() {
  const b = M.bonds.find((x) => x.id === bondMarket); if (!b) return;
  $('bf-name').textContent = b.name; $('bf-cur').textContent = b.name;
  $('bf-disc').textContent = fmt(b.discount * 100, 1) + '%';
  recalcBond();
}

// ---------- account ----------
async function loadAccount() {
  if (!wallet) { A = null; renderAccount(); return; }
  A = await api('/api/account', { wallet });
  if (A.error) { toast(A.error, true); A = null; }
  renderAccount();
}
function renderAccount() {
  if (A) {
    $('m-staked').textContent = fmt(A.staked, 2);
    $('m-earned').textContent = fmt(A.earned, 4);
    $('m-claimv').textContent = fmt(A.earned, 3);
  } else { $('m-staked').textContent = '—'; $('m-earned').textContent = '—'; $('m-claimv').textContent = '—'; }
  refreshMausField();
  renderYourBonds();
}
function renderYourBonds() {
  const box = $('yourbonds');
  if (!A || !A.bonds || !A.bonds.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="bal" style="margin-bottom:8px"><span>Your bonds</span><b></b></div>' + A.bonds.map((b, i) => `
    <div class="vb"><div style="min-width:46px;font-family:Cinzel;font-weight:700;font-size:13px">${b.market}</div>
      <div class="vbar"><i style="width:${(b.pct * 100).toFixed(1)}%"></i></div>
      <div style="font-size:12.5px;color:var(--sub);min-width:96px;text-align:right">${fmt(b.claimable, 2)} <b style="color:var(--ink)">claimable</b></div>
    </div>`).join('') +
    '<button class="btn ghost wide" id="claimbonds" style="margin-top:6px">Claim &amp; auto-stake vested TOMB</button>';
  const cb = $('claimbonds'); if (cb) cb.onclick = async () => { const r = await api('/api/bond/claim', { wallet, autostake: true }); if (r.error) return toast(r.error, true); A = r; renderAccount(); loadMetrics(); toast('Claimed ' + fmt(r.claimed, 3) + ' TOMB → staked'); };
}

// ---------- mausoleum ----------
let mTab = 'stake';
$('mt-stake').onclick = () => { mTab = 'stake'; $('mt-stake').classList.add('on'); $('mt-wd').classList.remove('on'); refreshMausField(); };
$('mt-wd').onclick = () => { mTab = 'wd'; $('mt-wd').classList.add('on'); $('mt-stake').classList.remove('on'); refreshMausField(); };
function refreshMausField() {
  const stake = mTab === 'stake';
  $('m-act').textContent = stake ? 'Stake TOMB' : 'Withdraw TOMB';
  $('m-ball').textContent = stake ? 'TOMB balance' : 'Staked TOMB';
  $('m-bal').textContent = A ? fmt(stake ? A.tomb : A.staked, 3) : '—';
}
$('m-max').onclick = () => { if (A) $('min').value = mTab === 'stake' ? A.tomb : A.staked; };
$('m-act').onclick = async () => {
  if (needWallet()) return;
  const amount = +$('min').value; if (!amount) return toast('Enter an amount', true);
  const r = await api('/api/' + (mTab === 'stake' ? 'stake' : 'unstake'), { wallet, amount });
  if (r.error) return toast(r.error, true);
  $('min').value = ''; A = r; renderAccount(); loadMetrics(); toast(mTab === 'stake' ? 'Staked ' + fmt(amount, 2) + ' TOMB' : 'Withdrew ' + fmt(amount, 2) + ' TOMB');
};
$('m-claim').onclick = async () => {
  if (needWallet()) return;
  const r = await api('/api/claim', { wallet }); if (r.error) return toast(r.error, true);
  A = r; renderAccount(); toast('Claimed ' + fmt(r.claimed, 3) + ' TOMB');
};

// ---------- bonds ----------
document.addEventListener('click', (e) => { const c = e.target.closest('[data-bm]'); if (c) { bondMarket = c.dataset.bm; renderBonds(); } });
function recalcBond() {
  if (!M) return; const b = M.bonds.find((x) => x.id === bondMarket); if (!b) return;
  const inp = +$('bin').value || 0; const usdVal = bondMarket === 'eth' ? inp * M.ethPrice : inp;
  $('bf-out').textContent = fmt(usdVal / b.priceUsd, 3) + ' TOMB';
}
$('bin').oninput = recalcBond;
$('bf-max').onclick = () => toast('Bonds take real ETH/USDC — enter the amount you want to bond');
$('bf-buy').onclick = async () => {
  if (needWallet()) return;
  const amount = +$('bin').value; if (!amount) return toast('Enter an amount', true);
  const r = await api('/api/bond', { wallet, market: bondMarket, amount });
  if (r.error) return toast(r.error, true);
  $('bin').value = ''; A = r; renderAccount(); loadMetrics(); toast('Bonded for ' + fmt(r.payout, 2) + ' TOMB (vesting)');
};

// ---------- CA copy ----------
$('ca-copy').onclick = () => { navigator.clipboard.writeText(M.mint); toast('Copied CA'); };

// ---------- live epoch clock ----------
function tickClock() {
  const ms = Math.max(0, nextEpochAt - Date.now());
  const s = Math.floor(ms / 1000), mm = Math.floor(s / 60), ss = s % 60;
  const str = String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  $('d-next').textContent = str; $('m-clock').textContent = str;
  if (ms <= 0 && !tickClock._r) { tickClock._r = true; setTimeout(() => { tickClock._r = false; loadMetrics(); loadAccount(); }, 1500); }
}
setInterval(tickClock, 250);

// ---------- boot ----------
(async function boot() {
  await api('/api/config');
  setConnected();
  await loadMetrics();
  await loadAccount();
  setInterval(loadMetrics, 12000);
})();
