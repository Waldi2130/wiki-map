// app.js — Wiki-карта. Базовая надёжность + слой фото + машина времени.

// === Диагностика: показываем ошибки прямо на экране ===
window.addEventListener('error', (e) => {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = 'JS: ' + (e.message || 'unknown');
    el.classList.remove('hidden');
    el.style.background = 'rgba(200,40,40,0.9)';
  }
});
window.addEventListener('unhandledrejection', (e) => {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = 'Promise: ' + (e.reason?.message || e.reason || 'unknown');
    el.classList.remove('hidden');
    el.style.background = 'rgba(200,40,40,0.9)';
  }
});

// === Сброс старого Service Worker и кэшей (на время отладки) ===
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {});
}
if ('caches' in window) {
  caches.keys()
    .then((keys) => keys.forEach((k) => caches.delete(k)))
    .catch(() => {});
}

(() => {
  // ============================================================
  // Constants
  // ============================================================
  const DEFAULT_CENTER = [55.7558, 37.6173];
  const DEFAULT_ZOOM = 13;
  const MIN_ZOOM_FOR_LOAD = 10;
  const MOVE_DEBOUNCE_MS = 500;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const RESULT_LIMIT = 100;

  const WIKI = 'https://ru.wikipedia.org';
  const COMMONS = 'https://commons.wikimedia.org';
  const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';

  // ============================================================
  // IndexedDB cache
  // ============================================================
  const dbPromise = new Promise((resolve) => {
    const req = indexedDB.open('wiki-map-cache', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });

  async function cacheGet(key) {
    const db = await dbPromise;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('cache', 'readonly');
        const r = tx.objectStore('cache').get(key);
        r.onsuccess = () => {
          const rec = r.result;
          if (!rec) return resolve(null);
          if (Date.now() - rec.t > CACHE_TTL_MS) return resolve(null);
          resolve(rec.v);
        };
        r.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function cacheSet(key, value) {
    const db = await dbPromise;
    if (!db) return;
    try {
      const tx = db.transaction('cache', 'readwrite');
      tx.objectStore('cache').put({ key, v: value, t: Date.now() });
    } catch {}
  }

  async function cachedFetch(key, url, signal) {
    const cached = await cacheGet(key);
    if (cached) return cached;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cacheSet(key, data);
    return data;
  }

  // ============================================================
  // Map setup
  // ============================================================
  // tap: false фиксит баг iOS Safari — без этого попапы маркеров не открываются на тач-экране
  const map = L.map('map', { zoomControl: false, tap: false, doubleClickZoom: true })
    .setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '© <a href="https://openstreetmap.org/copyright">OSM</a> · Данные: Википедия / Wikidata (CC BY-SA)',
    maxZoom: 19,
  }).addTo(map);

  // Layer groups
  const wikiCluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    iconCreateFunction: (cluster) =>
      L.divIcon({
        html: `<div class="cluster cluster-wiki">${cluster.getChildCount()}</div>`,
        className: '',
        iconSize: [40, 40],
      }),
  }).addTo(map);

  const photosCluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 60,
    iconCreateFunction: (cluster) =>
      L.divIcon({
        html: `<div class="cluster cluster-photos">${cluster.getChildCount()}</div>`,
        className: '',
        iconSize: [40, 40],
      }),
  });

  const timeCluster = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    iconCreateFunction: (cluster) =>
      L.divIcon({
        html: `<div class="cluster cluster-time">${cluster.getChildCount()}</div>`,
        className: '',
        iconSize: [40, 40],
      }),
  });

  const seenWiki = new Set();
  const seenPhotos = new Set();
  const seenTime = new Set();

  // Anchor (manual override of "where to search from")
  let anchorMarker = null;
  let anchorPos = null;

  // Self-position marker
  let selfMarker = null;

  // Toggles
  let photosEnabled = false;
  let timeEnabled = false;
  let timeRange = [1000, 2025];

  // ============================================================
  // Status bar
  // ============================================================
  const statusEl = document.getElementById('status');
  let statusTimer;
  function showStatus(text, autoHide = true) {
    statusEl.textContent = text;
    statusEl.classList.remove('hidden');
    clearTimeout(statusTimer);
    if (autoHide) statusTimer = setTimeout(() => statusEl.classList.add('hidden'), 2200);
  }

  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);

  const stripHtml = (s) =>
    String(s ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

  // ============================================================
  // Coordinates block — координаты + кнопка "Скопировать"
  // ============================================================
  function coordsBlock(lat, lon) {
    const txt = `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}`;
    return `<div class="coords">
      <span class="coord-text">📍 ${txt}</span>
      <button type="button" class="copy-btn" data-coords="${txt}">📋 Скопировать</button>
    </div>`;
  }

  function attachCopyHandler(marker) {
    marker.on('popupopen', (e) => {
      const popupEl = e.popup.getElement();
      if (!popupEl) return;
      const btn = popupEl.querySelector('.copy-btn');
      if (!btn || btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const coords = btn.dataset.coords;
        let ok = false;
        try {
          await navigator.clipboard.writeText(coords);
          ok = true;
        } catch {
          // Fallback для iOS Safari в не-secure контексте или старых версий
          try {
            const ta = document.createElement('textarea');
            ta.value = coords;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            ok = document.execCommand('copy');
            ta.remove();
          } catch {}
        }
        btn.textContent = ok ? '✓ Скопировано' : '✗ Не удалось';
        setTimeout(() => { btn.textContent = '📋 Скопировать'; }, 1500);
      });
    });
  }

  // ============================================================
  // Защита от переполнения: если маркеров слишком много, чистим
  // ============================================================
  const MAX_MARKERS = 400;
  function guardOverflow(cluster, seenSet, label) {
    if (seenSet.size > MAX_MARKERS) {
      cluster.clearLayers();
      seenSet.clear();
      showStatus(`Очистил ${label} (накопилось ${MAX_MARKERS}+)`);
    }
  }

  // ============================================================
  // Wikipedia: load articles in current map bbox
  // ============================================================
  let wikiAbort = null;

  async function loadWikiArticles() {
    const zoom = map.getZoom();
    if (zoom < MIN_ZOOM_FOR_LOAD) {
      showStatus('Приблизьте карту, чтобы искать места');
      return;
    }
    const b = map.getBounds();
    const ne = b.getNorthEast();
    const sw = b.getSouthWest();
    if (Math.abs(ne.lat - sw.lat) > 9 || Math.abs(ne.lng - sw.lng) > 9) {
      showStatus('Слишком большая область — приблизьте');
      return;
    }

    guardOverflow(wikiCluster, seenWiki, 'места');

    if (wikiAbort) wikiAbort.abort();
    wikiAbort = new AbortController();

    const center = anchorPos || [map.getCenter().lat, map.getCenter().lng];
    const cacheKey = `wiki:${center[0].toFixed(2)},${center[1].toFixed(2)}`;
    const url =
      `${WIKI}/w/api.php?action=query&list=geosearch` +
      `&gscoord=${center[0]}|${center[1]}&gsradius=10000` +
      `&gslimit=${RESULT_LIMIT}&format=json&origin=*`;

    showStatus('Ищу места…', false);
    try {
      const data = await cachedFetch(cacheKey, url, wikiAbort.signal);
      const items = data?.query?.geosearch || [];
      let added = 0;
      for (const it of items) {
        if (seenWiki.has(it.pageid)) continue;
        seenWiki.add(it.pageid);
        addWikiMarker(it);
        added++;
      }
      if (items.length === 0) showStatus('Здесь Википедия молчит');
      else showStatus(`Места: +${added} (всего ${seenWiki.size})`);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error(e);
        showStatus('Ошибка загрузки. Проверь интернет.');
      }
    }
  }

  function addWikiMarker(place) {
    const marker = L.marker([place.lat, place.lon]);
    const titleHtml = escapeHtml(place.title);
    const coords = coordsBlock(place.lat, place.lon);
    marker.bindPopup(
      `<div class="popup"><h3>${titleHtml}</h3>${coords}<p class="skeleton">Загружаю…</p></div>`,
      { maxWidth: 280 }
    );
    let loaded = false;
    marker.on('popupopen', async () => {
      if (loaded) return;
      try {
        const cacheKey = `summary:${place.title}`;
        const url = `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(place.title)}`;
        const d = await cachedFetch(cacheKey, url);
        const img = d.thumbnail?.source
          ? `<img src="${escapeHtml(d.thumbnail.source)}" alt="" loading="lazy">`
          : '';
        const extract = d.extract ? `<p>${escapeHtml(d.extract)}</p>` : '';
        const link = d.content_urls?.desktop?.page
          ? `<a href="${escapeHtml(d.content_urls.desktop.page)}" target="_blank" rel="noopener">Открыть в Википедии →</a>`
          : '';
        marker.setPopupContent(
          `<div class="popup">${img}<h3>${titleHtml}</h3>${extract}${coords}${link}</div>`
        );
        loaded = true;
      } catch {
        marker.setPopupContent(
          `<div class="popup"><h3>${titleHtml}</h3>${coords}<p>Не удалось загрузить.</p></div>`
        );
      }
    });
    attachCopyHandler(marker);
    wikiCluster.addLayer(marker);
  }

  // ============================================================
  // Wikimedia Commons: photos in radius
  // ============================================================
  let photosAbort = null;

  async function loadPhotos() {
    guardOverflow(photosCluster, seenPhotos, 'фото');
    if (photosAbort) photosAbort.abort();
    photosAbort = new AbortController();

    const center = anchorPos || [map.getCenter().lat, map.getCenter().lng];
    const cacheKey = `photos:${center[0].toFixed(2)},${center[1].toFixed(2)}`;
    const url =
      `${COMMONS}/w/api.php?action=query&list=geosearch&gsnamespace=6` +
      `&gscoord=${center[0]}|${center[1]}&gsradius=10000` +
      `&gslimit=50&format=json&origin=*`;

    showStatus('Ищу старые фото…', false);
    try {
      const data = await cachedFetch(cacheKey, url, photosAbort.signal);
      const files = data?.query?.geosearch || [];
      let added = 0;
      for (const f of files) {
        if (seenPhotos.has(f.pageid)) continue;
        seenPhotos.add(f.pageid);
        addPhotoMarker(f);
        added++;
      }
      showStatus(`Фото: +${added} (всего ${seenPhotos.size})`);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error(e);
        showStatus('Ошибка загрузки фото');
      }
    }
  }

  function addPhotoMarker(file) {
    const icon = L.divIcon({
      className: 'photo-marker',
      html: '<div class="photo-pin">📷</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const marker = L.marker([file.lat, file.lon], { icon });
    const titleHtml = escapeHtml(file.title.replace(/^File:/, ''));
    const coords = coordsBlock(file.lat, file.lon);
    marker.bindPopup(
      `<div class="popup"><h3>${titleHtml}</h3>${coords}<p class="skeleton">Загружаю фото…</p></div>`,
      { maxWidth: 300 }
    );
    let loaded = false;
    marker.on('popupopen', async () => {
      if (loaded) return;
      try {
        const cacheKey = `imageinfo:${file.title}`;
        const url =
          `${COMMONS}/w/api.php?action=query&prop=imageinfo` +
          `&iiprop=url|extmetadata&iiurlwidth=400` +
          `&titles=${encodeURIComponent(file.title)}&format=json&origin=*`;
        const d = await cachedFetch(cacheKey, url);
        const pages = d?.query?.pages || {};
        const page = Object.values(pages)[0];
        const info = page?.imageinfo?.[0];
        if (!info) throw new Error('No imageinfo');
        const meta = info.extmetadata || {};
        const date = stripHtml(meta.DateTimeOriginal?.value || meta.DateTime?.value).slice(0, 40);
        const author = stripHtml(meta.Artist?.value).slice(0, 60);
        const desc = stripHtml(meta.ImageDescription?.value).slice(0, 200);
        const license = stripHtml(meta.LicenseShortName?.value);
        const imgUrl = info.thumburl || info.url;
        const meta_lines = [
          desc && `<p>${escapeHtml(desc)}${desc.length === 200 ? '…' : ''}</p>`,
          date && `<p class="meta">📅 ${escapeHtml(date)}</p>`,
          author && `<p class="meta">👤 ${escapeHtml(author)}</p>`,
          license && `<p class="meta">© ${escapeHtml(license)}</p>`,
        ].filter(Boolean).join('');
        marker.setPopupContent(
          `<div class="popup">
            <a href="${escapeHtml(info.descriptionurl)}" target="_blank" rel="noopener">
              <img src="${escapeHtml(imgUrl)}" alt="" loading="lazy">
            </a>
            <h3>${titleHtml}</h3>
            ${meta_lines}${coords}
            <a href="${escapeHtml(info.descriptionurl)}" target="_blank" rel="noopener">Открыть в Commons →</a>
          </div>`
        );
        loaded = true;
      } catch {
        marker.setPopupContent(
          `<div class="popup"><h3>${titleHtml}</h3>${coords}<p>Не удалось загрузить фото.</p></div>`
        );
      }
    });
    attachCopyHandler(marker);
    photosCluster.addLayer(marker);
  }

  // ============================================================
  // Time machine — Wikidata SPARQL with bbox + inception filter
  // ============================================================
  let timeAbort = null;

  async function loadTimeMachine() {
    const zoom = map.getZoom();
    if (zoom < MIN_ZOOM_FOR_LOAD) {
      showStatus('Приблизьте карту для машины времени');
      return;
    }
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();

    if (timeAbort) timeAbort.abort();
    timeAbort = new AbortController();

    const sparql = `
      SELECT ?item ?itemLabel ?coord ?inception ?image WHERE {
        SERVICE wikibase:box {
          ?item wdt:P625 ?coord.
          bd:serviceParam wikibase:cornerSouthWest "Point(${sw.lng} ${sw.lat})"^^geo:wktLiteral.
          bd:serviceParam wikibase:cornerNorthEast "Point(${ne.lng} ${ne.lat})"^^geo:wktLiteral.
        }
        ?item wdt:P571 ?inception.
        FILTER(YEAR(?inception) >= ${timeRange[0]} && YEAR(?inception) <= ${timeRange[1]})
        OPTIONAL { ?item wdt:P18 ?image. }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }
      }
      LIMIT 200
    `.trim();
    const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(sparql)}&format=json`;
    const cacheKey = `time:${sw.lat.toFixed(2)},${sw.lng.toFixed(2)},${ne.lat.toFixed(2)},${ne.lng.toFixed(2)}:${timeRange[0]}-${timeRange[1]}`;

    showStatus(`Эпоха ${timeRange[0]}–${timeRange[1]}…`, false);
    try {
      const data = await cachedFetch(cacheKey, url, timeAbort.signal);
      const rows = data?.results?.bindings || [];
      timeCluster.clearLayers();
      seenTime.clear();
      let added = 0;
      for (const row of rows) {
        const id = row.item.value;
        if (seenTime.has(id)) continue;
        seenTime.add(id);
        const coord = parseWktPoint(row.coord.value);
        if (!coord) continue;
        const year = parseWikidataYear(row.inception.value);
        if (year === null) continue;
        addTimeMarker({
          id,
          lat: coord[1],
          lon: coord[0],
          title: row.itemLabel?.value || 'Объект',
          year,
          image: row.image?.value || null,
        });
        added++;
      }
      showStatus(`Эпоха ${timeRange[0]}–${timeRange[1]}: ${added}`);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error(e);
        showStatus('Машина времени недоступна');
      }
    }
  }

  function parseWktPoint(wkt) {
    const m = wkt.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
    if (!m) return null;
    return [parseFloat(m[1]), parseFloat(m[2])];
  }

  function parseWikidataYear(s) {
    const m = s.match(/^(-?\d+)/);
    if (!m) return null;
    return parseInt(m[1], 10);
  }

  function addTimeMarker(obj) {
    const icon = L.divIcon({
      className: 'time-marker',
      html: `<div class="time-pin">${obj.year}</div>`,
      iconSize: [54, 26],
      iconAnchor: [27, 13],
    });
    const marker = L.marker([obj.lat, obj.lon], { icon });
    const titleHtml = escapeHtml(obj.title);
    const imgHtml = obj.image
      ? `<img src="${escapeHtml(obj.image)}?width=400" alt="" loading="lazy">`
      : '';
    const qid = obj.id.split('/').pop();
    const wdUrl = `https://www.wikidata.org/wiki/${qid}`;
    const coords = coordsBlock(obj.lat, obj.lon);
    marker.bindPopup(
      `<div class="popup">
        ${imgHtml}<h3>${titleHtml}</h3>
        <p class="meta">📅 ${obj.year} год</p>
        ${coords}
        <a href="${wdUrl}" target="_blank" rel="noopener">Открыть в Wikidata →</a>
      </div>`,
      { maxWidth: 280 }
    );
    attachCopyHandler(marker);
    timeCluster.addLayer(marker);
  }

  // ============================================================
  // Anchor (long-press / right-click on map)
  // ============================================================
  map.on('contextmenu', (e) => {
    setAnchor(e.latlng);
  });

  function setAnchor(latlng) {
    if (anchorMarker) map.removeLayer(anchorMarker);
    anchorPos = [latlng.lat, latlng.lng];
    const icon = L.divIcon({
      className: 'anchor-marker',
      html: '⚓',
      iconSize: [36, 36],
      iconAnchor: [18, 18],
    });
    anchorMarker = L.marker(anchorPos, { icon }).addTo(map);
    anchorMarker.bindPopup('<b>Якорь поиска</b><br>Тап здесь — убрать.');
    anchorMarker.on('click', () => {
      if (anchorMarker) map.removeLayer(anchorMarker);
      anchorMarker = null;
      anchorPos = null;
      showStatus('Якорь убран');
      reloadAll();
    });
    showStatus('Якорь поставлен — поиск отсюда');
    reloadAll();
  }

  // ============================================================
  // Auto-load on map move (debounced + abort previous)
  // ============================================================
  let moveTimer;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      reloadAll();
    }, MOVE_DEBOUNCE_MS);
  });

  function reloadAll() {
    loadWikiArticles();
    if (photosEnabled) loadPhotos();
    if (timeEnabled) loadTimeMachine();
  }

  // ============================================================
  // UI buttons
  // ============================================================
  document.getElementById('locate').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showStatus('Геолокация недоступна');
      return;
    }
    showStatus('Определяю местоположение…', false);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        map.setView([latitude, longitude], 14);
        if (selfMarker) map.removeLayer(selfMarker);
        selfMarker = L.circleMarker([latitude, longitude], {
          radius: 8,
          color: '#fff',
          weight: 2,
          fillColor: '#1976d2',
          fillOpacity: 1,
        }).addTo(map);
      },
      (err) => {
        const messages = {
          1: 'Доступ к геолокации запрещён',
          2: 'Не удалось определить положение',
          3: 'Превышено время ожидания',
        };
        showStatus(messages[err.code] || 'Ошибка геолокации');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });

  const photosBtn = document.getElementById('photos-toggle');
  photosBtn.addEventListener('click', () => {
    photosEnabled = !photosEnabled;
    photosBtn.classList.toggle('active', photosEnabled);
    if (photosEnabled) {
      photosCluster.addTo(map);
      loadPhotos();
    } else {
      map.removeLayer(photosCluster);
    }
  });

  const timeBtn = document.getElementById('time-toggle');
  const timePanel = document.getElementById('time-panel');
  timeBtn.addEventListener('click', () => {
    timeEnabled = !timeEnabled;
    timeBtn.classList.toggle('active', timeEnabled);
    timePanel.classList.toggle('open', timeEnabled);
    if (timeEnabled) {
      timeCluster.addTo(map);
      loadTimeMachine();
    } else {
      map.removeLayer(timeCluster);
    }
  });

  // Time slider
  const timeFromInput = document.getElementById('time-from');
  const timeToInput = document.getElementById('time-to');
  const timeFromLabel = document.getElementById('time-from-label');
  const timeToLabel = document.getElementById('time-to-label');

  function fmtYear(y) {
    const n = parseInt(y, 10);
    return n < 0 ? `${-n} до н.э.` : `${n}`;
  }

  let timeUpdateTimer;
  function onTimeChange() {
    const from = parseInt(timeFromInput.value, 10);
    const to = parseInt(timeToInput.value, 10);
    if (from > to) {
      // keep ordered: nudge
      timeFromInput.value = to;
    }
    timeRange = [parseInt(timeFromInput.value, 10), parseInt(timeToInput.value, 10)];
    timeFromLabel.textContent = fmtYear(timeRange[0]);
    timeToLabel.textContent = fmtYear(timeRange[1]);
    if (!timeEnabled) return;
    clearTimeout(timeUpdateTimer);
    timeUpdateTimer = setTimeout(loadTimeMachine, 400);
  }
  ['input', 'change'].forEach((ev) => {
    timeFromInput.addEventListener(ev, onTimeChange);
    timeToInput.addEventListener(ev, onTimeChange);
  });
  // init labels
  timeFromLabel.textContent = fmtYear(timeFromInput.value);
  timeToLabel.textContent = fmtYear(timeToInput.value);

  // ============================================================
  // PWA Service Worker — отключён на время отладки.
  // Включим обратно, когда поймём что всё работает на iPhone.
  // ============================================================

  // ============================================================
  // Initial load
  // ============================================================
  reloadAll();
})();
