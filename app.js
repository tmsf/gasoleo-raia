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
  dlg: $('#mapDlg'), map: $('#map'), mapTitle: $('#mapTitle'), mapGo: $('#mapGo'), mapClose: $('#mapClose'),
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

function renderSummary() {
  const best = (cc) => state.stations.find((s) => s.country === cc);
  const pt = best('PT'), es = best('ES');
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
  els.dlg.showModal();
  history.pushState({ map: true }, '');

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

function closeMap() { if (els.dlg.open) els.dlg.close(); }
els.mapClose.addEventListener('click', () => history.back());
els.dlg.addEventListener('click', (e) => { if (e.target === els.dlg) history.back(); });
els.dlg.addEventListener('cancel', (e) => { e.preventDefault(); history.back(); });
// Android back button / swipe closes the map instead of leaving the site.
window.addEventListener('popstate', closeMap);

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
