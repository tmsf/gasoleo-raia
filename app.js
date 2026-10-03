// Gasóleo Raia — diesel prices between Tui (ES) and Caminha (PT).
// Both official APIs send `Access-Control-Allow-Origin: *`, so no backend is needed.

const PT_API =
  'https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos' +
  '?idsTiposComb=2101&idMarca=&idTipoPosto=&idDistrito=16' + // 2101 = Gasóleo simples, 16 = Viana do Castelo
  '&idsMunicipios=234,243,241&qtdPorPagina=100&pagina=1';     // Caminha, V. N. Cerveira, Valença
const ES_API = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroMunicipio/';
const ES_MUNICIPIOS = [5322, 5321, 5315, 5289]; // Tui, Tomiño, O Rosal, A Guarda

const CACHE_KEY = 'diesel-raia:v2';
const FILTER_KEY = 'diesel-raia:filter';
const CACHE_TTL = 30 * 60 * 1000; // ES updates every 30 min, PT roughly daily
const STALE_DAYS = 2;

// Brand -> logo file. Stations whose brand has no findable logo simply get none.
const LOGOS = [
  [/\bGALP\b/, 'galp'],
  [/REPSOL/, 'repsol'],
  [/^BP\b|\bBP\b/, 'bp'],
  [/FREITAS|TF ?GEST/, 'freitas'],
  [/CEPSA|MOEVE/, 'moeve'],
  [/PETRONOR/, 'petronor'],
  [/BALLENOIL/, 'ballenoil'],
  [/GASLANDER/, 'gaslander'],
  [/CARBUGAL/, 'carbugal'],
  [/^SBC\b/, 'sbc'],
  [/SERTUY/, 'sertuy'],
  [/OUTLETUI/, 'outletui'],
  [/\bPRIO\b/, 'prio'],
  [/PINGO DOCE/, 'pingodoce'],
];

const $ = (s) => document.querySelector(s);
const els = {
  list: $('#list'), empty: $('#empty'), fresh: $('#fresh'), summary: $('#summary'),
  chips: $('#chips'), refresh: $('#refresh'), tpl: $('#cardTpl'),
  dlg: $('#mapDlg'), map: $('#map'), mapTitle: $('#mapTitle'), mapGo: $('#mapGo'),
  saved: $('#saved'), toast: $('#toast'), toastUndo: $('#toastUndo'),
  fillDlg: $('#fillDlg'), fillForm: $('#fillForm'), fillTitle: $('#fillTitle'), fillNote: $('#fillNote'),
  fillL: $('#fillL'), fillE: $('#fillE'), fillP: $('#fillP'), fillSubmit: $('#fillSubmit'),
  histDlg: $('#histDlg'), histStats: $('#histStats'), histTable: $('#histTable'), histRows: $('#histRows'),
  histEmpty: $('#histEmpty'), histHint: $('#histHint'), histCsv: $('#histCsv'),
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let state = { stations: [], meta: {}, filter: store.get(FILTER_KEY) || 'all' };

/* ---------- helpers ---------- */

const norm = (s = '') => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const num = (s) => parseFloat(String(s).replace(/[^\d,.-]/g, '').replace(',', '.'));

function titleCase(s = '') {
  return s.toLowerCase().replace(/(^|[\s\-/(.])(\p{L})/gu, (m, p, c) => p + c.toUpperCase())
    .replace(/\b(Da|De|Do|Das|Dos|E|Del|La|El|Y)\b/g, (w) => w.toLowerCase())
    .replace(/^./, (c) => c.toUpperCase());
}
const dec = (n, d = 3) => n.toFixed(d).replace('.', ',');
const plain = (n, d = 2) => String(+n.toFixed(d)).replace('.', ','); // 40 -> "40", 37.5 -> "37,5"
const eur = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const brandName = (s) => (s.length <= 3 ? s.toUpperCase() : titleCase(s));

function logoFor(...names) {
  for (const n of names.map(norm)) for (const [re, file] of LOGOS) if (re.test(n)) return file;
  return null;
}

// Wall-clock time in a given IANA zone -> real Date.
function zoned(y, mo, d, h = 0, mi = 0, s = 0, tz) {
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utc)).map((x) => [x.type, +x.value]));
  const asTz = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return new Date(utc - (asTz - utc));
}
const parsePT = (s) => { const [d, t = '0:0'] = s.split(' '); const [y, m, dd] = d.split('-'); const [h, mi] = t.split(':'); return zoned(+y, +m, +dd, +h, +mi, 0, 'Europe/Lisbon'); };
const parseES = (s) => { const [d, t = '0:0:0'] = s.split(' '); const [dd, m, y] = d.split('/'); const [h, mi, se] = t.split(':'); return zoned(+y, +m, +dd, +h, +mi, +se, 'Europe/Madrid'); };

const fmtTime = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short' });
function when(date) {
  if (!date) return '—';
  const days = Math.floor((startOfDay(new Date()) - startOfDay(date)) / 864e5);
  if (days === 0) return `hoje às ${fmtTime.format(date)}`;
  if (days === 1) return `ontem às ${fmtTime.format(date)}`;
  return `${fmtDay.format(date)} (há ${days} dias)`;
}
// Spanish opening hours ("L-V: 07:00-22:00; S-D: 24H") -> Portuguese ("Seg–Sex: …; Sáb–Dom: 24h").
const DIAS = { L: 'Seg', M: 'Ter', X: 'Qua', J: 'Qui', V: 'Sex', S: 'Sáb', D: 'Dom' };
const horario = (h = '') => h
  .replace(/(^|;\s*)([LMXJVSD])(?:-([LMXJVSD]))?:/g, (m, p, a, b) => p + DIAS[a] + (b ? '–' + DIAS[b] : '') + ':')
  .replace(/24H/g, '24h');

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 6e4);
  return m < 1 ? 'agora mesmo' : m < 60 ? `há ${m} min` : `há ${Math.round(m / 60)} h`;
}

/* ---------- data ---------- */

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function fetchPT() {
  const j = await getJSON(PT_API);
  const rows = j.resultado || [];
  const stations = rows.map((x) => {
    const generic = /GEN[EÉ]RICO/i.test(x.Marca || '');
    return {
      id: `pt-${x.Id}`,
      country: 'PT',
      name: generic ? titleCase(x.Nome) : brandName(x.Marca),
      detail: generic ? '' : x.Nome,
      address: titleCase(x.Morada || ''),
      town: titleCase(x.Localidade || x.Municipio),
      price: num(x.Preco),
      updated: x.DataAtualizacao ? parsePT(x.DataAtualizacao).getTime() : null,
      lat: x.Latitude, lon: x.Longitude,
      logo: logoFor(x.Marca, x.Nome),
      fuel: 'Gasóleo',
    };
  }).filter((s) => s.price > 0);
  const latest = Math.max(...stations.map((s) => s.updated || 0)) || null;
  return { stations, latest };
}

// The ES feed has at times swapped latitude/longitude; pick by magnitude (lat ≈ 42, lon ≈ -8.7).
function esCoords(a, b) {
  const x = num(a), y = num(b);
  return Math.abs(x) > Math.abs(y) ? [x, y] : [y, x];
}

async function fetchES() {
  const results = await Promise.all(ES_MUNICIPIOS.map((id) => getJSON(ES_API + id)));
  const feedDate = results.map((r) => r.Fecha).filter(Boolean).map((f) => parseES(f).getTime());
  const rows = results.flatMap((r) => r.ListaEESSPrecio || [])
    .filter((x) => x['Precio Gasoleo A'] && x['Tipo Venta'] !== 'R'); // R = restricted to members
  const dupes = new Map();
  rows.forEach((x) => { const k = x['Rótulo'] + x.IDMunicipio; dupes.set(k, (dupes.get(k) || 0) + 1); });
  const stations = rows.map((x) => {
    const [lat, lon] = esCoords(x['Latitud'], x['Longitud (WGS84)']);
    const side = dupes.get(x['Rótulo'] + x.IDMunicipio) > 1 ? ({ D: 'lado direito', I: 'lado esquerdo' })[x.Margen] : '';
    return {
      id: `es-${x.IDEESS}`,
      country: 'ES',
      name: brandName(x['Rótulo']),
      detail: [horario(x.Horario), side].filter(Boolean).join(' · '),
      address: titleCase(x['Dirección'] || ''),
      town: titleCase(x.Localidad || x.Municipio),
      price: num(x['Precio Gasoleo A']),
      updated: null,
      lat, lon,
      logo: logoFor(x['Rótulo']),
      fuel: 'Gasóleo A',
    };
  });
  return { stations, latest: feedDate.length ? Math.max(...feedDate) : null };
}

async function load(force = false) {
  const cached = store.get(CACHE_KEY);
  if (cached) apply(cached);
  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL) return;

  els.refresh.classList.add('spin');
  els.list.setAttribute('aria-busy', 'true');
  const [pt, es] = await Promise.allSettled([fetchPT(), fetchES()]);
  const prev = cached?.byCountry || {};
  const byCountry = {
    PT: pt.status === 'fulfilled' ? { ...pt.value, ok: true } : { ...(prev.PT || { stations: [] }), ok: false },
    ES: es.status === 'fulfilled' ? { ...es.value, ok: true } : { ...(prev.ES || { stations: [] }), ok: false },
  };
  [pt, es].forEach((r) => r.status === 'rejected' && console.warn(r.reason));
  const data = { fetchedAt: Date.now(), byCountry };
  if (byCountry.PT.ok || byCountry.ES.ok) store.set(CACHE_KEY, data);
  els.refresh.classList.remove('spin');
  apply(data);
}

function apply(data) {
  const { PT, ES } = data.byCountry;
  state.stations = [...PT.stations, ...ES.stations].sort((a, b) => a.price - b.price);
  state.meta = data;
  renderFresh();
  renderSummary();
  render();
}

/* ---------- render ---------- */

function renderFresh() {
  const { byCountry: c, fetchedAt } = state.meta;
  const row = (cc, label, src, info) => `
    <div class="fresh__row ${info.ok === false ? 'is-err' : ''}">
      <i class="flag flag--${cc.toLowerCase()}"></i>
      <span><b>${label}</b> ${src}</span>
      <span class="fresh__when">${info.ok === false ? 'sem ligação · ' : ''}${info.latest ? when(new Date(info.latest)) : '—'}</span>
    </div>`;
  els.fresh.innerHTML =
    '<div class="fresh__head">Últimos dados</div>' +
    row('PT', 'PT', 'DGEG', c.PT) +
    row('ES', 'ES', 'MITECO', c.ES) +
    `<div class="fresh__fetched">Consultado ${ago(fetchedAt)}</div>`;
}

const cheapest = (cc) => state.stations.find((s) => s.country === cc);

function renderSummary() {
  const pt = cheapest('PT'), es = cheapest('ES');
  if (!pt || !es) { els.summary.hidden = true; return; }
  const [lo, hi] = pt.price <= es.price ? [pt, es] : [es, pt];
  const diff = hi.price - lo.price;
  const [country, cheaper] = lo.country === 'ES' ? ['Espanha', 'mais barata'] : ['Portugal', 'mais barato'];
  els.summary.hidden = false;
  els.summary.innerHTML = `
    <i class="flag flag--${lo.country.toLowerCase()}"></i>
    <p><b>${country}</b> está <b>${diff.toFixed(3).replace('.', ',')} €/L</b> ${cheaper}
    <span>· ${(diff * 50).toFixed(2).replace('.', ',')} € num depósito de 50 L</span></p>`;
}

function drums(price) {
  const [int, dec] = price.toFixed(3).split('.');
  const digit = (d, small) =>
    `<span class="drum${small ? ' drum--small' : ''}"><span class="drum__strip" style="--d:${d}">${'0123456789'.split('').map((n) => `<span>${n}</span>`).join('')}</span></span>`;
  return [...int].map((d) => digit(d)).join('') + '<span class="drums__sep">,</span>' +
    digit(dec[0]) + digit(dec[1]) + digit(dec[2], true);
}

function render() {
  const f = state.filter;
  els.chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', c.dataset.f === f));
  const list = state.stations.filter((s) => f === 'all' || s.country === f);
  const min = list[0]?.price;

  els.list.replaceChildren(...list.map((s, i) => {
    const li = els.tpl.content.firstElementChild.cloneNode(true);
    li.classList.toggle('card--best', i === 0);
    li.querySelector('.rank').textContent = i + 1;
    const logo = li.querySelector('.logo');
    if (s.logo) logo.innerHTML = `<img src="logos/${s.logo}.png" alt="" width="44" height="44" loading="lazy">`;
    else logo.classList.add('logo--none');
    li.querySelector('.name').innerHTML = `${esc(s.name)} <i class="flag flag--${s.country.toLowerCase()}" title="${s.country}"></i>`;
    li.querySelector('.place').textContent = [s.detail, s.address, s.town].filter(Boolean).join(' · ');
    li.querySelector('.sign__label').textContent = s.fuel;
    const d = li.querySelector('.drums');
    d.innerHTML = drums(s.price);
    d.setAttribute('role', 'img');
    d.setAttribute('aria-label', `${s.price.toFixed(3).replace('.', ',')} euros por litro`);

    const meta = [];
    if (i === 0) meta.push('<span class="tag tag--best">Mais barato</span>');
    else meta.push(`<span class="tag">+${(s.price - min).toFixed(3).replace('.', ',')} €</span>`);
    if (s.updated) {
      const stale = Date.now() - s.updated > STALE_DAYS * 864e5;
      meta.push(`<span class="${stale ? 'stale' : ''}">Atualizado ${when(new Date(s.updated))}</span>`);
    } else if (state.meta.byCountry.ES.latest) {
      meta.push(`<span>Preço em vigor ${when(new Date(state.meta.byCountry.ES.latest))}</span>`);
    }
    li.querySelector('.meta').innerHTML = meta.join('');
    li.querySelector('.map-btn').addEventListener('click', () => openMap(s));
    li.querySelector('.fill-btn').addEventListener('click', () => openFill(s));
    return li;
  }));

  els.list.setAttribute('aria-busy', 'false');
  els.empty.hidden = list.length > 0;
  const anyOk = state.meta.byCountry && (state.meta.byCountry.PT.ok !== false || state.meta.byCountry.ES.ok !== false);
  els.empty.textContent = anyOk ? 'Nenhum posto encontrado para este filtro.' : 'Não foi possível carregar os preços. Verifique a ligação e toque em atualizar.';

  // Stagger the odometer roll-in down the list.
  els.list.querySelectorAll('.drum__strip').forEach((el, i) => {
    el.style.animationDelay = `${Math.min(i * 25, 700)}ms`;
  });
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ---------- dialogs ---------- */

// Each open dialog gets a history entry, so the Android back button / swipe closes it instead of leaving the site.
const dialogs = [els.dlg, els.fillDlg, els.histDlg];
function openDlg(d) {
  d.showModal();
  history.pushState({ dlg: d.id }, '');
}
window.addEventListener('popstate', () => dialogs.forEach((d) => d.open && d.close()));
dialogs.forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target === d) history.back(); });
  d.addEventListener('cancel', (e) => { e.preventDefault(); history.back(); });
});
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => history.back()));

let toastTimer;
function toast(msg, undo) {
  // Inside an open modal, or the backdrop would cover it.
  (dialogs.find((d) => d.open) || document.body).append(els.toast);
  els.toast.firstElementChild.textContent = msg;
  els.toastUndo.onclick = () => { undo(); els.toast.hidden = true; };
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
}

/* ---------- map ---------- */

let leaflet, map, markers = new Map();

function loadLeaflet() {
  if (leaflet) return leaflet;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  document.head.append(css);
  leaflet = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
    s.onload = () => res(window.L);
    s.onerror = rej;
    document.head.append(s);
  });
  return leaflet;
}

// Apple devices get Apple Maps (opens the Maps app); everyone else Google Maps.
// iPadOS reports itself as "Macintosh", so the Mac check also covers iPads.
const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
function directionsUrl({ lat, lon }) {
  return IS_APPLE
    ? `https://maps.apple.com/directions?destination=${lat},${lon}&mode=driving`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

async function openMap(station) {
  els.mapTitle.innerHTML = `<b>${esc(station.name)}</b> <span>${station.price.toFixed(3).replace('.', ',')} €</span>`;
  els.mapGo.href = directionsUrl(station);
  if (!els.dlg.open) openDlg(els.dlg);

  const L = await loadLeaflet();
  if (!map) {
    map = L.map(els.map, { zoomControl: false, fadeAnimation: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap',
    }).addTo(map);
  }
  markers.forEach((m) => m.remove());
  markers.clear();
  state.stations.forEach((s) => {
    const sel = s.id === station.id;
    const m = L.marker([s.lat, s.lon], {
      zIndexOffset: sel ? 1000 : 0,
      icon: L.divIcon({
        className: '',
        html: `<div class="pin${sel ? ' pin--sel' : ''} pin--${s.country.toLowerCase()}">${s.price.toFixed(3).replace('.', ',')}</div>`,
        iconSize: null,
      }),
    }).addTo(map).on('click', () => openMap(s));
    markers.set(s.id, m);
  });
  map.invalidateSize();
  map.setView([station.lat, station.lon], 15);
}

/* ---------- fill-ups (stored only in this browser) ---------- */

const FILLS_KEY = 'diesel-raia:fills';
const LAST_FILL_KEY = 'diesel-raia:last-fill';
const COUNTRY = { PT: 'Portugal', ES: 'Espanha' };
const STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const fmtFill = new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtFillShort = new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const fillDate = (at) => (new Date(at).getFullYear() === new Date().getFullYear() ? fmtFillShort : fmtFill).format(at);

let fills = store.get(FILLS_KEY) || [];
let fill = null; // the fill-up being entered: { station, src } — src is the field the user typed, 'l' or 'e'

function saveFills() {
  fills.sort((a, b) => a.at - b.at);
  store.set(FILLS_KEY, fills);
  renderSaved();
  if (els.histDlg.open) renderHistory();
}

// Fills in whichever of litres / amount the user didn't type. The saving compares the price paid
// with the cheapest station across the border right now; null when that side has no prices.
function quote() {
  const s = fill.station;
  const paid = num(els.fillP.value);
  let litres = num(els.fillL.value), amount = num(els.fillE.value);
  if (fill.src === 'l') { amount = litres * paid; els.fillE.value = amount > 0 ? plain(amount) : ''; }
  else { litres = amount / paid; els.fillL.value = litres > 0 && isFinite(litres) ? plain(litres) : ''; }
  const other = s.country === 'PT' ? 'ES' : 'PT';
  const ref = cheapest(other)?.price ?? null;
  const ok = paid > 0 && litres > 0 && isFinite(litres);
  const saved = ok && ref ? Math.round((ref - paid) * litres * 100) / 100 : null;
  return { ok, s, paid, litres, amount, other, ref, saved };
}

function renderQuote() {
  const q = quote();
  els.fillSubmit.disabled = !q.ok;
  els.fillNote.classList.toggle('is-neg', q.saved < 0);
  els.fillNote.innerHTML = !q.ok ? ''
    : q.ref == null ? `Sem preços de ${COUNTRY[q.other]} para comparar.`
    : q.saved >= 0 ? `Poupa <b>${eur.format(q.saved)}</b> face a ${COUNTRY[q.other]} (${dec(q.ref)} €/L)`
    : `Paga mais <b>${eur.format(-q.saved)}</b> do que em ${COUNTRY[q.other]} (${dec(q.ref)} €/L)`;
}

function openFill(station) {
  const last = store.get(LAST_FILL_KEY) || { src: 'l', value: 40 };
  fill = { station, src: last.src };
  els.fillTitle.innerHTML = `<b>${esc(station.name)}</b> <span>${esc(station.town)}</span>`;
  els.fillP.value = dec(station.price);
  els.fillL.value = els.fillE.value = '';
  (last.src === 'l' ? els.fillL : els.fillE).value = plain(last.value);
  renderQuote();
  openDlg(els.fillDlg);
}

els.fillL.addEventListener('input', () => { fill.src = 'l'; renderQuote(); });
els.fillE.addEventListener('input', () => { fill.src = 'e'; renderQuote(); });
els.fillP.addEventListener('input', renderQuote);

els.fillForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = quote();
  if (!q.ok) return;
  const f = {
    id: Date.now().toString(36), at: Date.now(),
    stationId: q.s.id, station: q.s.name, town: q.s.town, country: q.s.country,
    litres: +q.litres.toFixed(2), amount: +q.amount.toFixed(2), paid: q.paid,
    pricePT: q.s.country === 'PT' ? q.paid : q.ref,
    priceES: q.s.country === 'ES' ? q.paid : q.ref,
    saved: q.saved,
  };
  fills.push(f);
  saveFills();
  store.set(LAST_FILL_KEY, { src: fill.src, value: fill.src === 'l' ? f.litres : f.amount });
  navigator.storage?.persist?.(); // ask the browser not to evict this data
  els.fillDlg.close(); // close now so the toast lands on the page, not in the closing dialog
  history.back();
  toast('Abastecimento registado', () => { fills = fills.filter((x) => x.id !== f.id); saveFills(); });
});

function totals() {
  const known = fills.filter((f) => f.saved != null);
  return {
    n: fills.length,
    known: known.length,
    saved: known.reduce((a, f) => a + f.saved, 0),
    litres: fills.reduce((a, f) => a + f.litres, 0),
  };
}

function renderSaved() {
  const t = totals();
  els.saved.hidden = !t.n;
  if (!t.n) return;
  els.saved.classList.toggle('is-neg', t.saved < 0);
  els.saved.innerHTML = `
    <span>${t.saved >= 0 ? 'Já poupou' : 'Saldo'} <b>${eur.format(t.saved)}</b> em ${t.n} abastecimento${t.n > 1 ? 's' : ''}</span>
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M9 6l6 6-6 6"/></svg>`;
}

function renderHistory() {
  const t = totals();
  els.histStats.innerHTML = `
    <div class="stat ${t.saved < 0 ? 'stat--bad' : 'stat--good'}"><span>Poupado</span><b>${eur.format(t.saved)}</b><small>no total</small></div>
    <div class="stat"><span>Litros</span><b>${plain(t.litres, 0)} L</b><small>em ${t.n} ${t.n > 1 ? 'vezes' : 'vez'}</small></div>
    <div class="stat"><span>Média</span><b>${t.known ? eur.format(t.saved / t.known) : '—'}</b><small>por vez</small></div>`;
  const price = (f, cc) => (f[`price${cc}`] == null ? '—'
    : `<span class="${f.country === cc ? 'paid' : ''}">${dec(f[`price${cc}`])}</span>`);
  els.histRows.innerHTML = [...fills].reverse().map((f) => `
    <tr>
      <td class="fills__st"><b><i class="flag flag--${f.country.toLowerCase()}"></i> ${esc(f.station)}</b><small>${fillDate(f.at)}</small></td>
      <td class="n">${plain(f.litres)}</td>
      <td class="n">${price(f, 'PT')}</td>
      <td class="n">${price(f, 'ES')}</td>
      <td class="n ${f.saved == null ? '' : f.saved < 0 ? 'neg' : 'pos'}">${f.saved == null ? '—' : eur.format(f.saved)}</td>
      <td><button type="button" class="del" data-id="${f.id}" aria-label="Apagar abastecimento de ${fmtFill.format(f.at)}">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>
      </button></td>
    </tr>`).join('');
  els.histTable.hidden = !t.n;
  els.histEmpty.hidden = !!t.n;
  els.histHint.hidden = !IS_APPLE || STANDALONE;
}

els.histRows.addEventListener('click', (e) => {
  const b = e.target.closest('.del');
  if (!b) return;
  const f = fills.find((x) => x.id === b.dataset.id);
  fills = fills.filter((x) => x !== f);
  saveFills();
  toast('Abastecimento apagado', () => { fills.push(f); saveFills(); });
});

// Semicolons and decimal commas, so it opens straight into Excel / Numbers in PT and ES locales.
function exportCsv() {
  const cell = (v) => (v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',')
    : /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const head = ['data', 'posto', 'localidade', 'pais', 'litros', 'valor_eur', 'preco_pago', 'preco_pt', 'preco_es', 'poupanca_eur'];
  const rows = fills.map((f) => [
    new Date(f.at).toLocaleString('sv-SE').slice(0, 16), // local "2026-10-03 14:20"
    f.station, f.town, f.country, f.litres, f.amount, f.paid, f.pricePT, f.priceES, f.saved,
  ].map(cell).join(';'));
  const blob = new Blob(['\ufeff' + [head.join(';'), ...rows].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `gasoleo-raia-${new Date().toLocaleDateString('sv-SE')}.csv`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
els.histCsv.addEventListener('click', exportCsv);

els.saved.addEventListener('click', () => { renderHistory(); openDlg(els.histDlg); });
renderSaved();

/* ---------- wiring ---------- */

els.chips.addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.filter = b.dataset.f;
  store.set(FILTER_KEY, state.filter);
  render();
});
els.refresh.addEventListener('click', () => load(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

load().catch((e) => {
  console.error(e);
  els.refresh.classList.remove('spin');
  els.empty.hidden = false;
  els.empty.textContent = 'Não foi possível carregar os preços. Verifique a ligação e toque em atualizar.';
});
