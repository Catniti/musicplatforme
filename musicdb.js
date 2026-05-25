/**
 * MusicPlatforme Server DB Client
 * Подключи этот файл в index.html ПОСЛЕ Firebase и ПЕРЕД основным скриптом.
 *
 * Для подключения своего сервера:
 * 1. Установите URL сервера в localStorage: localStorage.setItem('mp_server_url', 'https://your-server.com/api')
 * 2. Или настройте через Панель Создателя → Настройки сервера
 */
(function () {
  'use strict';

  /* ===== НАСТРОЙКИ ===== */
  const DEFAULT_SERVER = '';

  function detectServerBase() {
    try {
      const override = localStorage.getItem('mp_server_url_override');
      if (override && override.startsWith('http')) return override.replace(/\/$/, '') + (override.includes('/api') ? '' : '/api');
      const saved = localStorage.getItem('mp_server_url');
      if (saved && saved.startsWith('http')) return saved.replace(/\/$/, '') + (saved.includes('/api') ? '' : '/api');
    } catch { /* ignore */ }
    return DEFAULT_SERVER;
  }

  const SERVER_BASE = detectServerBase();
  const SERVER_TIMEOUT_MS = 8000;
  const SYNC_RETRY_INTERVAL_MS = 30000;
  const CONFIG_KEY = 'mp_db_config';

  /* ===== FIX: localStorage квота — чистим тяжёлые поля из mp_user ===== */
  (function patchLocalStorage() {
    const LARGE_FIELD_THRESHOLD = 5000;
    const FIELDS_TO_STRIP = ['audioData','coverData','audioBase64','coverBase64','audio','cover'];

    function stripHeavy(obj) {
      if (!obj || typeof obj !== 'object') return obj;
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (FIELDS_TO_STRIP.includes(k)) { out[k] = null; continue; }
        if (typeof v === 'string' && v.length > LARGE_FIELD_THRESHOLD && v.startsWith('data:')) {
          out[k] = null;
          continue;
        }
        out[k] = v;
      }
      return out;
    }

    function freeSpace() {
      try {
        const q = JSON.parse(localStorage.getItem('mp_sync_queue') || '[]');
        if (q.length > 50) {
          localStorage.setItem('mp_sync_queue', JSON.stringify(q.slice(-20)));
        }
        const played = Object.keys(localStorage).filter(k => k.startsWith('mp_played_'));
        if (played.length > 3) played.slice(0, played.length - 3).forEach(k => localStorage.removeItem(k));
      } catch {}
    }

    const _orig = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      let val = value;
      if (key === 'mp_user') {
        try {
          const parsed = JSON.parse(value);
          val = JSON.stringify(stripHeavy(parsed));
        } catch {}
      }
      try {
        _orig.call(this, key, val);
      } catch (e) {
        if (e && (e.name === 'QuotaExceededError' || e.code === 22 || String(e).includes('quota'))) {
          console.warn('[MusicDB] localStorage quota — освобождаем место для:', key);
          freeSpace();
          try { _orig.call(this, key, val); } catch (e2) {
            if (key === 'mp_user') {
              try {
                const minimal = JSON.parse(val);
                const tiny = { uid: minimal.uid, username: minimal.username, displayName: minimal.displayName, email: minimal.email, role: minimal.role, isCreator: minimal.isCreator };
                _orig.call(this, key, JSON.stringify(tiny));
              } catch {}
            }
          }
        }
      }
    };
  })();

  /* ===== КОНФИГУРАЦИЯ ===== */
  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    } catch { return {}; }
  }
  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  const defaultConfig = {
    primarySource: 'auto', // 'server' | 'firebase' | 'auto'
    autoSync: true,
  };

  /* ===== СТАТУС СЕРВЕРА ===== */
  let serverAvailable = null;
  let serverLastChecked = 0;
  let firebaseAvailable = null;
  let firebaseLastChecked = 0;

  async function checkServerAvailable() {
    const now = Date.now();
    if (now - serverLastChecked < 10000 && serverAvailable !== null) return serverAvailable;
    try {
      const r = await fetchWithTimeout(SERVER_BASE + '/healthz', {}, 3000);
      serverAvailable = r.ok;
      serverLastChecked = Date.now();
      return serverAvailable;
    } catch {
      serverAvailable = false;
      serverLastChecked = Date.now();
      return false;
    }
  }

  function setFirebaseAvailable(v) {
    firebaseAvailable = !!v;
    firebaseLastChecked = Date.now();
  }

  /* ===== HTTP УТИЛИТЫ ===== */
  async function fetchWithTimeout(url, options = {}, ms = SERVER_TIMEOUT_MS) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      const r = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(t);
      return r;
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }

  async function serverGet(path) {
    const r = await fetchWithTimeout(SERVER_BASE + path, {
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('server-' + r.status);
    return r.json();
  }

  async function serverPost(path, body) {
    const r = await fetchWithTimeout(SERVER_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('server-' + r.status);
    return r.json();
  }

  async function serverPut(path, body) {
    const r = await fetchWithTimeout(SERVER_BASE + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('server-' + r.status);
    return r.json();
  }

  async function serverPatch(path, body) {
    const r = await fetchWithTimeout(SERVER_BASE + path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('server-' + r.status);
    return r.json();
  }

  async function serverDelete(path) {
    const r = await fetchWithTimeout(SERVER_BASE + path, { method: 'DELETE' });
    if (!r.ok) throw new Error('server-' + r.status);
    return r.json();
  }

  /* ===== ОЧЕРЕДЬ СИНХРОНИЗАЦИИ ===== */
  const LOCAL_QUEUE_KEY = 'mp_sync_queue';

  function getLocalQueue() {
    try { return JSON.parse(localStorage.getItem(LOCAL_QUEUE_KEY) || '[]'); } catch { return []; }
  }
  function saveLocalQueue(q) {
    localStorage.setItem(LOCAL_QUEUE_KEY, JSON.stringify(q));
  }
  function addToLocalQueue(item) {
    const q = getLocalQueue();
    q.push({ ...item, id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), ts: Date.now(), synced: false });
    saveLocalQueue(q);
  }
  function markQueueItemSynced(id) {
    const q = getLocalQueue().map(i => i.id === id ? { ...i, synced: true } : i);
    saveLocalQueue(q);
  }

  /* ===== СОХРАНЕНИЕ ТРЕКА ===== */
  async function saveTrackToServer(trackId, trackData) {
    try {
      const ok = await checkServerAvailable();
      if (!ok) {
        addToLocalQueue({ collection: 'tracks', docId: trackId, action: 'set', data: trackData });
        console.warn('[MusicDB] Server unavailable, track queued for sync', trackId);
        return { saved: false, queued: true };
      }
      await serverPost('/tracks', { ...trackData, id: trackId });
      console.log('[MusicDB] Track saved to server', trackId);
      return { saved: true, queued: false };
    } catch (e) {
      console.warn('[MusicDB] saveTrackToServer failed, queuing', e.message);
      addToLocalQueue({ collection: 'tracks', docId: trackId, action: 'set', data: trackData });
      return { saved: false, queued: true };
    }
  }

  async function saveTrackEverywhere(trackId, trackData) {
    let serverResult = null;
    let firebaseResult = null;

    serverResult = await saveTrackToServer(trackId, trackData);

    if (firebaseAvailable !== false && window.firebase && window.firebase.database) {
      try {
        const db = window.firebase.database();
        await db.ref('tracks/' + trackId).set(trackData);
        firebaseResult = { saved: true };
        setFirebaseAvailable(true);
        console.log('[MusicDB] Track saved to Firebase', trackId);
      } catch (e) {
        console.warn('[MusicDB] Firebase save failed, server is fallback', e.message);
        setFirebaseAvailable(false);
        firebaseResult = { saved: false, error: e.message };
        if (!serverResult.queued && !serverResult.saved) {
          addToLocalQueue({ collection: 'tracks', docId: trackId, action: 'set', data: trackData });
        }
      }
    }

    return { server: serverResult, firebase: firebaseResult };
  }

  /* ===== ЗАГРУЗКА ТРЕКОВ ===== */
  async function loadTracksFromServer() {
    try {
      const ok = await checkServerAvailable();
      if (!ok) return null;
      const res = await serverGet('/tracks');
      if (!res.ok) return null;
      return res.data;
    } catch { return null; }
  }

  async function loadTracksWithFallback() {
    const cfg = { ...defaultConfig, ...getConfig() };
    const src = cfg.primarySource;

    if (src === 'server') {
      const serverTracks = await loadTracksFromServer();
      if (serverTracks) return { data: serverTracks, source: 'server' };
      if (window.firebase) {
        const db = window.firebase.database();
        return new Promise(resolve => {
          db.ref('tracks').once('value', snap => {
            setFirebaseAvailable(true);
            resolve({ data: snap.val() || {}, source: 'firebase-fallback' });
          }).catch(() => {
            setFirebaseAvailable(false);
            resolve({ data: {}, source: 'none' });
          });
        });
      }
      return { data: {}, source: 'none' };
    }

    if (src === 'firebase') {
      if (window.firebase) {
        const db = window.firebase.database();
        return new Promise(resolve => {
          const t = setTimeout(() => {
            setFirebaseAvailable(false);
            loadTracksFromServer().then(data => {
              resolve({ data: data || {}, source: data ? 'server-fallback' : 'none' });
            });
          }, 5000);
          db.ref('tracks').once('value', snap => {
            clearTimeout(t);
            setFirebaseAvailable(true);
            resolve({ data: snap.val() || {}, source: 'firebase' });
          }).catch(() => {
            clearTimeout(t);
            setFirebaseAvailable(false);
            loadTracksFromServer().then(data => {
              resolve({ data: data || {}, source: data ? 'server-fallback' : 'none' });
            });
          });
        });
      }
    }

    // auto: пробуем оба, берём тот что быстрее ответит
    const serverPromise = loadTracksFromServer().then(d => d ? { data: d, source: 'server' } : null);
    if (window.firebase) {
      const db = window.firebase.database();
      const firebasePromise = new Promise(resolve => {
        const t = setTimeout(() => {
          setFirebaseAvailable(false);
          resolve(null);
        }, 6000);
        db.ref('tracks').once('value', snap => {
          clearTimeout(t);
          setFirebaseAvailable(true);
          resolve({ data: snap.val() || {}, source: 'firebase' });
        }).catch(() => {
          clearTimeout(t);
          setFirebaseAvailable(false);
          resolve(null);
        });
      });

      const winner = await Promise.race([serverPromise, firebasePromise]);
      if (winner) return winner;
      const fallback = await Promise.race([serverPromise, firebasePromise]);
      return fallback || { data: {}, source: 'none' };
    }
    const res = await serverPromise;
    return res || { data: {}, source: 'none' };
  }

  /* ===== ФОНОВАЯ СИНХРОНИЗАЦИЯ ===== */
  async function syncQueueToFirebase() {
    if (!window.firebase) return;
    const db = window.firebase.database();
    const q = getLocalQueue().filter(i => !i.synced);
    if (!q.length) return;
    for (const item of q) {
      try {
        if (item.action === 'set' && item.collection === 'tracks') {
          await db.ref('tracks/' + item.docId).set(item.data);
          markQueueItemSynced(item.id);
          setFirebaseAvailable(true);
          console.log('[MusicDB] Synced queued track to Firebase:', item.docId);
        }
      } catch (e) {
        setFirebaseAvailable(false);
        console.warn('[MusicDB] Firebase sync failed for', item.docId, e.message);
        break;
      }
    }
  }

  let _lastAutoAlignTs = 0;
  const AUTO_ALIGN_INTERVAL_MS = 5 * 60 * 1000; // каждые 5 минут

  async function backgroundAutoAlign() {
    const now = Date.now();
    if (now - _lastAutoAlignTs < AUTO_ALIGN_INTERVAL_MS) return;
    _lastAutoAlignTs = now;
    const ok = await checkServerAvailable();
    if (!ok || !window.firebase) return;
    try {
      // Загружаем треки из Firebase (с таймаутом)
      const tracksData = await getFirebaseCollectionClean('tracks', 7000);
      const firebaseIds = Object.keys(tracksData);
      const diff = await getDiff(firebaseIds);
      if (!diff) return;

      const isCreator = typeof window.isCreatorUser === 'function' && window.isCreatorUser(window.currentUser);
      let synced = 0;

      // Firebase → Сервер: добавляем треки которых нет на сервере (только реальные, не ghost)
      if (diff.onlyFirebaseCount > 0 && (diff.onlyFirebase || []).length > 0) {
        const toImport = {};
        for (const id of diff.onlyFirebase) {
          const t = tracksData[id];
          // Пропускаем ghost-записи (без title, audioUrl и artistName)
          if (!t || typeof t !== 'object' || (!t.title && !t.audioUrl && !t.artistName)) continue;
          toImport[id] = t;
        }
        if (Object.keys(toImport).length > 0) {
          await serverPost('/sync/import-from-firebase', { tracks: toImport });
          synced += Object.keys(toImport).length;
        }
      }

      // Сервер → Firebase: добавляем треки которых нет в Firebase
      if (diff.onlyServerCount > 0) {
        await exportServerTracksToFirebase();
        synced += diff.onlyServerCount;
      }

      if (synced > 0 && isCreator && typeof window.showSnackbar === 'function') {
        window.showSnackbar('🔄 Авто-синхр.: +' + synced + ' треков выровнено');
      }
      console.log('[MusicDB] backgroundAutoAlign done. synced:', synced, 'diff:', diff.onlyFirebaseCount, '/', diff.onlyServerCount);
    } catch (e) {
      console.warn('[MusicDB] backgroundAutoAlign error:', e.message);
    }
  }

  async function backgroundSyncLoop() {
    const ok = await checkServerAvailable();
    if (!ok) {
      console.warn('[MusicDB] Server offline, will retry sync later');
      setTimeout(backgroundSyncLoop, SYNC_RETRY_INTERVAL_MS);
      return;
    }
    await syncQueueToFirebase();
    await backgroundAutoAlign();
    setTimeout(backgroundSyncLoop, SYNC_RETRY_INTERVAL_MS);
  }

  /* ===== DIFF И ВЫРАВНИВАНИЕ ===== */
  const MIRRORED_COLS = [
    'tracks','users','usernames','emails','favorites','playlists',
    'pinnedTracks','subscriptions','subscribers',
    'history','notifications','reports','trackVideoData',
  ];
  // Коллекции для выравнивания (без creatorLogs — он слишком большой)
  const ALIGN_COLS = [
    'tracks','users','usernames','emails','favorites','playlists',
    'pinnedTracks','subscriptions','subscribers','history','notifications','reports','trackVideoData',
  ];

  async function getDiff(firebaseIds) {
    try {
      const ok = await checkServerAvailable();
      if (!ok) return null;
      // Filter out null/empty IDs (Firebase returns null for deleted items)
      const validIds = Array.isArray(firebaseIds) ? firebaseIds.filter(Boolean) : [];
      const qs = validIds.length ? '?firebaseIds=' + validIds.join(',') : '';
      return await serverGet('/sync/diff' + qs);
    } catch { return null; }
  }

  async function importFromFirebaseToServer(firebaseTracks) {
    try {
      const ok = await checkServerAvailable();
      if (!ok) return null;
      return await serverPost('/sync/import-from-firebase', { tracks: firebaseTracks });
    } catch { return null; }
  }

  async function importAllCollectionsToServer(allData) {
    try {
      const ok = await checkServerAvailable();
      if (!ok) return null;
      return await serverPost('/sync/import-all-collections', allData);
    } catch { return null; }
  }

  async function exportServerTracksToFirebase() {
    if (!window.firebase) return null;
    try {
      const ok = await checkServerAvailable();
      if (!ok) return null;
      const res = await serverGet('/sync/export-to-firebase-payload');
      if (!res.ok) return null;
      const db = window.firebase.database();
      const tracks = res.tracks || {};
      const updates = {};
      for (const [id, t] of Object.entries(tracks)) {
        updates['tracks/' + id] = t;
      }
      if (Object.keys(updates).length) await db.ref('/').update(updates);
      return { synced: Object.keys(updates).length };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function getFirebaseCollectionClean(col, timeoutMs) {
    const ms = timeoutMs || 6000;
    try {
      if (!window.firebase) return {};
      const fdb = window.firebase.database();
      return await new Promise((resolve) => {
        const timer = setTimeout(() => {
          console.warn('[MusicDB] Firebase timeout reading:', col);
          resolve({});
        }, ms);
        fdb.ref(col).once('value', snap => {
          clearTimeout(timer);
          const data = snap.val() || {};
          const clean = {};
          for (const [id, val] of Object.entries(data)) {
            if (val != null) clean[id] = val;
          }
          resolve(clean);
        }, () => { clearTimeout(timer); resolve({}); });
      });
    } catch { return {}; }
  }

  /* ===== СТАТУС СЕРВИСОВ (для панели создателя) ===== */
  async function getServicesStatus() {
    const result = {
      server: { status: 'checking', latencyMs: null, details: null },
      firebase: { status: 'checking', latencyMs: null, details: null },
      syncQueue: { pending: 0, total: 0 },
      config: { ...defaultConfig, ...getConfig() },
    };

    // Проверяем сервер
    const serverStart = Date.now();
    try {
      const r = await fetchWithTimeout(SERVER_BASE + '/admin/status', {}, 5000);
      if (r.ok) {
        result.server.latencyMs = Date.now() - serverStart;
        result.server.details = await r.json();
        result.server.status = 'ok';
        serverAvailable = true;
      } else {
        result.server.status = 'error';
        serverAvailable = false;
      }
    } catch (e) {
      result.server.status = 'offline';
      result.server.latencyMs = Date.now() - serverStart;
      serverAvailable = false;
    }

    // Проверяем Firebase
    if (window.firebase && window.firebase.database) {
      const fbStart = Date.now();
      try {
        const db = window.firebase.database();
        await new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('timeout')), 5000);
          db.ref('.info/connected').once('value', snap => {
            clearTimeout(t);
            resolve(snap.val());
          }).catch(e => { clearTimeout(t); reject(e); });
        });
        result.firebase.latencyMs = Date.now() - fbStart;
        result.firebase.status = 'ok';
        setFirebaseAvailable(true);
      } catch (e) {
        result.firebase.latencyMs = Date.now() - fbStart;
        result.firebase.status = e.message === 'timeout' ? 'timeout' : 'error';
        setFirebaseAvailable(false);
      }
    } else {
      result.firebase.status = 'not-loaded';
    }

    // Очередь синхронизации
    const q = getLocalQueue();
    result.syncQueue.pending = q.filter(i => !i.synced).length;
    result.syncQueue.total = q.length;

    return result;
  }

  /* ===== ПАНЕЛЬ СОЗДАТЕЛЯ — РЕАЛЬНЫЕ ДАННЫЕ ===== */
  async function openServiceStatusPanel() {
    const status = await getServicesStatus();
    return status;
  }

  function formatLatency(ms) {
    if (ms === null) return '—';
    if (ms < 100) return ms + 'мс ⚡';
    if (ms < 500) return ms + 'мс';
    return ms + 'мс ⚠️';
  }

  function statusIcon(s) {
    if (s === 'ok') return '✅';
    if (s === 'checking') return '⏳';
    if (s === 'timeout') return '⏱️';
    if (s === 'not-loaded') return '⚠️';
    return '❌';
  }

  function buildServiceStatusHtml(status) {
    const srv = status.server;
    const fb = status.firebase;
    const cfg = status.config;
    const q = status.syncQueue;

    const serverDetail = srv.details ? srv.details.server || {} : {};
    const dbDetail = srv.details ? srv.details.database || {} : {};

    const primaryOpts = ['auto', 'server', 'firebase'].map(v =>
      `<option value="${v}"${cfg.primarySource === v ? ' selected' : ''}>${v === 'auto' ? '🔄 Авто (кто быстрее)' : v === 'server' ? '🖥️ Только сервер' : '🔥 Только Firebase'}</option>`
    ).join('');

    return `
<div style="display:flex;flex-direction:column;gap:16px">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
    <div style="background:var(--md-surface-container);border-radius:16px;padding:14px;border:1px solid var(--md-outline-variant)">
      <div style="font:700 13px/18px 'Inter',sans-serif;color:var(--md-on-surface);margin-bottom:8px;display:flex;align-items:center;gap:6px">
        ${statusIcon(srv.status)} 🖥️ Сервер
      </div>
      <div style="font:400 12px/18px 'Inter',sans-serif;color:var(--md-on-surface-variant)">
        Статус: <b>${srv.status === 'ok' ? 'Работает' : srv.status === 'offline' ? 'Не доступен' : 'Ошибка'}</b><br>
        Пинг: ${formatLatency(srv.latencyMs)}<br>
        ${serverDetail.uptimeFormatted ? 'Аптайм: ' + serverDetail.uptimeFormatted + '<br>' : ''}
        ${serverDetail.memoryUsedMb ? 'RAM: ' + serverDetail.memoryUsedMb + ' МБ<br>' : ''}
        ${dbDetail.tracks !== undefined ? 'Треков в БД: ' + dbDetail.tracks + '<br>' : ''}
        ${dbDetail.users !== undefined ? 'Пользователей: ' + dbDetail.users : ''}
      </div>
    </div>
    <div style="background:var(--md-surface-container);border-radius:16px;padding:14px;border:1px solid var(--md-outline-variant)">
      <div style="font:700 13px/18px 'Inter',sans-serif;color:var(--md-on-surface);margin-bottom:8px;display:flex;align-items:center;gap:6px">
        ${statusIcon(fb.status)} 🔥 Firebase
      </div>
      <div style="font:400 12px/18px 'Inter',sans-serif;color:var(--md-on-surface-variant)">
        Статус: <b>${fb.status === 'ok' ? 'Подключена' : fb.status === 'timeout' ? 'Таймаут (перегружена)' : fb.status === 'not-loaded' ? 'Не загружена' : 'Ошибка'}</b><br>
        Пинг: ${formatLatency(fb.latencyMs)}<br>
        Роль: <b>Резервная (fallback)</b>
      </div>
    </div>
  </div>

  <div style="background:var(--md-surface-container);border-radius:16px;padding:14px;border:1px solid var(--md-outline-variant)">
    <div style="font:700 13px/18px 'Inter',sans-serif;color:var(--md-on-surface);margin-bottom:10px">⚙️ Источник данных</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <select id="mpPrimarySourceSelect" class="md-input" style="flex:1;min-width:180px;padding:10px 14px;border-radius:12px;margin:0">
        ${primaryOpts}
      </select>
      <label style="display:flex;align-items:center;gap:6px;font:500 13px/18px 'Inter',sans-serif;cursor:pointer">
        <input type="checkbox" id="mpAutoSyncCheck"${cfg.autoSync ? ' checked' : ''} style="width:16px;height:16px;cursor:pointer">
        Авто-синхронизация
      </label>
      <button class="btn-primary" onclick="window.MusicDB.saveConfig()" style="padding:8px 16px">Сохранить</button>
    </div>
    <div id="mpSourceWarning" style="display:none;margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);font:400 12px/17px 'Inter',sans-serif;color:#92400e"></div>
    <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="font:400 11px 'Inter';color:var(--md-on-surface-variant);margin-bottom:4px">URL сервера (из кода): <code style="font-size:10px;background:var(--md-surface-container-high);padding:1px 5px;border-radius:4px;word-break:break-all">${SERVER_BASE}</code></div>
        <div style="display:flex;gap:6px;align-items:center">
          <input id="mpServerUrlInput" class="md-input" placeholder="Новый URL (если изменился после republish)" value="${localStorage.getItem('mp_server_url_override')||''}" style="flex:1;font-size:11px;padding:6px 10px;border-radius:8px;margin:0">
          <button class="btn-tonal" onclick="(function(){const v=document.getElementById('mpServerUrlInput').value.trim();if(v){localStorage.setItem('mp_server_url_override',v);window.showSnackbar&&window.showSnackbar('URL обновлён — перезагрузи страницу');}else{localStorage.removeItem('mp_server_url_override');window.showSnackbar&&window.showSnackbar('URL сброшен');}})()" style="padding:6px 10px;font-size:11px;min-width:0;white-space:nowrap">Сохранить</button>
        </div>
      </div>
      <span id="mpActiveSourceBadge" style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;font:600 11px 'Inter';flex-shrink:0">⌛ Определяется...</span>
    </div>
  </div>

  <div style="background:var(--md-surface-container);border-radius:16px;padding:14px;border:1px solid var(--md-outline-variant)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <div style="font:700 13px/18px 'Inter',sans-serif;color:var(--md-on-surface)">📊 Выравнивание данных <span style="font:400 10px 'Inter';color:var(--md-outline)">v2</span></div>
      <button class="btn-tonal" onclick="if(window._mpAlignRunning){if(typeof window.showSnackbar==='function')window.showSnackbar('⏳ Подожди — выравнивание идёт...');return;}window.MusicDB.showDiff()" style="padding:4px 10px;font-size:12px;min-width:0">
        <span class="material-symbols-rounded" style="font-size:15px">refresh</span>
      </button>
    </div>
    <div style="font:400 12px/18px 'Inter',sans-serif;color:var(--md-on-surface-variant);margin-bottom:10px">
      Сравни треки сервера и Firebase, найди различия и выровняй только то, что отличается.
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn-tonal" onclick="if(window._mpAlignRunning){if(typeof window.showSnackbar==='function')window.showSnackbar('⏳ Подожди — выравнивание идёт...');return;}window.MusicDB.showDiff()" style="padding:8px 14px;font-size:13px">
        <span class="material-symbols-rounded" style="font-size:16px">compare_arrows</span> Показать различия
      </button>
      <button class="btn-primary" onclick="window.MusicDB.alignAll()" style="padding:8px 14px;font-size:13px">
        <span class="material-symbols-rounded" style="font-size:16px">sync_alt</span> Выровнять всё
      </button>
    </div>
    <div id="mpDiffResult" style="margin-top:10px;font:400 12px/18px 'Inter',sans-serif;color:var(--md-on-surface-variant)"></div>
  </div>
</div>`;
  }

  /* ===== ПУБЛИЧНОЕ API ===== */
  const MusicDB = {
    SERVER_BASE,
    serverAvailable: () => serverAvailable,
    firebaseAvailable: () => firebaseAvailable,
    checkServerAvailable,
    setFirebaseAvailable,
    saveTrack: saveTrackEverywhere,
    saveTrackToServer,
    loadTracks: loadTracksWithFallback,
    getServicesStatus,
    getDiff,
    importFromFirebaseToServer,
    exportServerTracksToFirebase,
    syncQueueToFirebase,
    getLocalQueue,

    saveConfig: async function() {
      const sel = document.getElementById('mpPrimarySourceSelect');
      const chk = document.getElementById('mpAutoSyncCheck');
      if (!sel) return;
      const chosen = sel.value;
      const cfg = { primarySource: chosen, autoSync: chk ? chk.checked : true };

      // Предупреждение если выбирают источник с меньшими данными
      if (chosen === 'server' || chosen === 'firebase') {
        try {
          const serverCount = await (async () => {
            const r = await fetchWithTimeout(SERVER_BASE + '/sync/diff', {}, 4000);
            if (r.ok) { const d = await r.json(); return d.serverCount ?? 0; }
            return 0;
          })();
          const fbCount = await (async () => {
            const data = await getFirebaseCollectionClean('tracks', 5000);
            return Object.keys(data).length;
          })();
          const chosenCount = chosen === 'server' ? serverCount : fbCount;
          const otherCount = chosen === 'server' ? fbCount : serverCount;
          const otherName = chosen === 'server' ? 'Firebase' : 'Сервере';
          if (otherCount > chosenCount && otherCount - chosenCount >= 1) {
            const warnEl = document.getElementById('mpSourceWarning');
            const msg = `⚠️ Небезопасно! В источнике "${chosen === 'server' ? 'Сервер' : 'Firebase'}" меньше треков (${chosenCount} vs ${otherCount} на ${otherName}). Сначала выровняйте данные кнопкой «Выровнять», иначе часть треков станет недоступна.`;
            if (warnEl) {
              warnEl.style.display = 'block';
              warnEl.textContent = msg;
            } else {
              if (typeof window.showSnackbar === 'function') window.showSnackbar(msg);
            }
            return; // не сохраняем пока не подтвердят
          }
        } catch {}
      }
      // Скрываем предупреждение если всё ok
      const warnEl = document.getElementById('mpSourceWarning');
      if (warnEl) warnEl.style.display = 'none';
      saveConfig(cfg);
      if (typeof window.showSnackbar === 'function') window.showSnackbar('Источник данных сохранён: ' + chosen);
      applySourceSwitch(cfg);
    },

    clearSyncedItems: function() {
      const q = getLocalQueue().filter(i => !i.synced);
      saveLocalQueue(q);
      if (typeof window.showSnackbar === 'function') window.showSnackbar('Синхронизированные элементы удалены из очереди');
    },

    runSyncNow: async function() {
      if (typeof window.showSnackbar === 'function') window.showSnackbar('Синхронизация...');
      await syncQueueToFirebase();
      const q = getLocalQueue();
      const pending = q.filter(i => !i.synced).length;
      if (typeof window.showSnackbar === 'function')
        window.showSnackbar(pending === 0 ? 'Всё синхронизировано!' : 'Осталось в очереди: ' + pending);
    },

    showDiff: async function() {
      const resultEl = document.getElementById('mpDiffResult');
      // Если сейчас идёт выравнивание — не перезаписываем прогресс
      if (window._mpAlignRunning) return;
      if (resultEl) resultEl.innerHTML = '<div style="padding:8px;color:var(--md-on-surface-variant);font:400 12px \'Inter\'">⏳ Загружаем данные из Firebase...</div>';
      if (!window.firebase) {
        if (resultEl) resultEl.textContent = 'Firebase не загружена';
        return;
      }

      // Загружаем COUNT для каждой коллекции из Firebase параллельно (с общим таймаутом)
      const firebaseCounts = {};
      let tracksData = {};
      await Promise.all(ALIGN_COLS.map(async col => {
        try {
          const data = await getFirebaseCollectionClean(col, col === 'tracks' ? 10000 : 5000);
          firebaseCounts[col] = Object.keys(data).length;
          if (col === 'tracks') tracksData = data;
        } catch {
          firebaseCounts[col] = -1;
        }
      }));
      setFirebaseAvailable(true);

      // Получаем diff по всем коллекциям с сервера за один запрос
      let diffAll = null;
      try {
        const ok = await checkServerAvailable();
        if (ok) diffAll = await serverPost('/sync/diff-all', { firebaseCounts });
      } catch {}

      // Детальный diff треков (onlyServer / onlyFirebase с ID)
      const firebaseTrackIds = Object.keys(tracksData);
      const trackDiff = await getDiff(firebaseTrackIds);

      if (!diffAll && !trackDiff) {
        if (resultEl) resultEl.textContent = 'Сервер недоступен';
        return;
      }

      // --- Карточки названий треков ---
      function trackCard(id, t, kind) {
        const hasData = t && (t.title || t.audioUrl || t.artistName);
        const title = hasData ? (t.title || id) : null;
        const artist = (t && t.artistName) ? t.artistName : '';
        const icon = kind === 'firebase' ? '🔥' : '🖥️';
        const bg = kind === 'firebase' ? 'rgba(255,87,34,.07)' : 'rgba(103,80,164,.07)';
        const safeId = encodeURIComponent(id);
        if (!hasData && kind === 'firebase') {
          // Ghost-запись только в Firebase — удаляем из Firebase
          return `<div style="padding:5px 10px;background:rgba(183,28,28,.07);border-radius:8px;font:400 12px 'Inter';display:flex;align-items:center;gap:8px;border:1px solid rgba(183,28,28,.15)">
            <span>⚠️</span>
            <div style="flex:1;min-width:0">
              <b style="color:var(--md-error)">Пустая запись (FB)</b>
              <span style="color:var(--md-on-surface-variant);margin-left:6px;font-size:11px">${id}</span>
            </div>
            <button onclick="window._mpDeleteGhostTrack('${safeId}')" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(183,28,28,.3);background:rgba(183,28,28,.1);color:var(--md-error);font:500 11px 'Inter';cursor:pointer;flex-shrink:0">Удалить</button>
          </div>`;
        }
        if (kind === 'server') {
          // Трек только на сервере — показываем ID и кнопку удаления с сервера
          return `<div style="padding:5px 10px;background:rgba(103,80,164,.07);border-radius:8px;font:400 12px 'Inter';display:flex;align-items:center;gap:8px;border:1px solid rgba(103,80,164,.15)">
            <span>🖥️</span>
            <div style="flex:1;min-width:0">
              <b style="color:var(--md-on-surface)">${title || id}</b>${artist ? `<span style="color:var(--md-on-surface-variant)"> — ${artist}</span>` : ''}
              ${!hasData ? `<span style="color:var(--md-on-surface-variant);margin-left:4px;font-size:11px">${id}</span>` : ''}
            </div>
            <button onclick="window._mpDeleteServerTrack('${safeId}')" style="padding:3px 8px;border-radius:6px;border:1px solid rgba(103,80,164,.3);background:rgba(103,80,164,.1);color:var(--md-primary);font:500 11px 'Inter';cursor:pointer;flex-shrink:0">Удалить</button>
          </div>`;
        }
        return `<div style="padding:5px 10px;background:${bg};border-radius:8px;font:400 12px 'Inter';display:flex;align-items:center;gap:8px">
          <span>${icon}</span>
          <div><b style="color:var(--md-on-surface)">${title || id}</b>${artist ? `<span style="color:var(--md-on-surface-variant)"> — ${artist}</span>` : ''}</div>
        </div>`;
      }

      // --- Таблица всех коллекций ---
      let collectionRows = '';
      if (diffAll && diffAll.collections) {
        const colEntries = Object.entries(diffAll.collections).filter(([col]) => ALIGN_COLS.includes(col));
        collectionRows = colEntries.map(([col, info]) => {
          const hasDiff = info.firebase >= 0 && info.diff > 0;
          const syncOk = info.firebase >= 0 && info.diff === 0;
          const icon = col === 'tracks' ? '🎵' : col === 'users' ? '👤' : col === 'playlists' ? '📋' : col === 'favorites' ? '❤️' : col === 'reports' ? '🚩' : '📦';
          const diffBadge = hasDiff
            ? `<span style="padding:1px 7px;border-radius:999px;background:rgba(245,158,11,.15);color:#b45309;font:700 11px 'Inter'">±${info.diff}</span>`
            : syncOk
            ? `<span style="padding:1px 7px;border-radius:999px;background:rgba(76,175,80,.12);color:#2e7d32;font:700 11px 'Inter'">✓</span>`
            : `<span style="padding:1px 7px;border-radius:999px;background:rgba(0,0,0,.07);color:var(--md-on-surface-variant);font:700 11px 'Inter'">?</span>`;
          return `<tr>
            <td style="padding:4px 6px;font:400 12px 'Inter'">${icon} <b>${col}</b></td>
            <td style="padding:4px 6px;text-align:center;font:600 13px 'Inter';color:var(--md-primary)">${info.server}</td>
            <td style="padding:4px 6px;text-align:center;font:600 13px 'Inter';color:var(--md-secondary)">${info.firebase >= 0 ? info.firebase : '—'}</td>
            <td style="padding:4px 6px;text-align:center">${diffBadge}</td>
          </tr>`;
        }).join('');
      }

      const onlyFirebaseTracks = (trackDiff ? (trackDiff.onlyFirebase || []) : []).slice(0, 15)
        .map(id => trackCard(id, tracksData[id], 'firebase'));
      const onlyServerTrackIds = (trackDiff ? (trackDiff.onlyServer || []) : []).slice(0, 15)
        .map(id => trackCard(id, null, 'server'));
      const trackDiffCount = trackDiff ? (trackDiff.onlyFirebaseCount + trackDiff.onlyServerCount) : 0;

      const html = `
        ${collectionRows ? `
        <div style="overflow-x:auto;margin-top:4px">
          <table style="width:100%;border-collapse:collapse;font:400 12px 'Inter'">
            <thead><tr>
              <th style="padding:4px 6px;text-align:left;font:600 11px 'Inter';color:var(--md-on-surface-variant)">Коллекция</th>
              <th style="padding:4px 6px;text-align:center;font:600 11px 'Inter';color:var(--md-on-surface-variant)">🖥️</th>
              <th style="padding:4px 6px;text-align:center;font:600 11px 'Inter';color:var(--md-on-surface-variant)">🔥</th>
              <th style="padding:4px 6px;text-align:center;font:600 11px 'Inter';color:var(--md-on-surface-variant)">Diff</th>
            </tr></thead>
            <tbody>${collectionRows}</tbody>
          </table>
        </div>` : ''}

        ${trackDiffCount === 0
          ? `<div style="margin-top:8px;padding:8px;background:rgba(76,175,80,.08);border-radius:10px;font:400 12px 'Inter'">✅ Треки синхронизированы</div>`
          : ''}

        ${onlyFirebaseTracks.length > 0 ? `
          <div style="margin-top:10px;font:600 12px 'Inter';color:var(--md-on-surface-variant);margin-bottom:5px">🔥 Только в Firebase — ${trackDiff.onlyFirebaseCount} трек(ов):</div>
          <div style="display:flex;flex-direction:column;gap:3px">
            ${onlyFirebaseTracks.join('')}
            ${trackDiff.onlyFirebaseCount > 15 ? `<div style="font:400 11px 'Inter';color:var(--md-on-surface-variant);padding:3px 10px">...ещё ${trackDiff.onlyFirebaseCount - 15}</div>` : ''}
          </div>` : ''}

        ${onlyServerTrackIds.length > 0 ? `
          <div style="margin-top:10px;font:600 12px 'Inter';color:var(--md-on-surface-variant);margin-bottom:5px">🖥️ Только на сервере — ${trackDiff.onlyServerCount} трек(ов):</div>
          <div style="display:flex;flex-direction:column;gap:3px">
            ${onlyServerTrackIds.join('')}
            ${trackDiff.onlyServerCount > 15 ? `<div style="font:400 11px 'Inter';color:var(--md-on-surface-variant);padding:3px 10px">...ещё ${trackDiff.onlyServerCount - 15}</div>` : ''}
          </div>` : ''}

        <div style="margin-top:8px;font:400 10px 'Inter';color:var(--md-on-surface-variant)">Обновлено: ${new Date().toLocaleTimeString('ru-RU')}</div>
      `;
      if (resultEl && !window._mpAlignRunning) resultEl.innerHTML = html;
    },

    alignAll: async function() {
      if (!window.firebase) {
        if (typeof window.showSnackbar === 'function') window.showSnackbar('Firebase не загружена');
        return;
      }
      if (window._mpAlignRunning) {
        if (typeof window.showSnackbar === 'function') window.showSnackbar('Выравнивание уже идёт...');
        return;
      }
      window._mpAlignRunning = true;
      const isCreator = typeof window.isCreatorUser === 'function' && window.isCreatorUser(window.currentUser);
      const resultEl = document.getElementById('mpDiffResult');

      // --- Двойной прогресс-бар ---
      // overallTotal определяется динамически после сканирования
      let overallTotal = 1; // минимум 1 (фаза сканирования)
      let overallStep = 0;
      let subPct = 0;
      let subTimer = null;
      let overallLabel = 'Сканирование...';
      let subLabel = '';
      let doneSteps = [];

      function renderBars() {
        if (!resultEl || !window._mpAlignRunning) return;
        const overallPct = overallTotal > 0 ? Math.round((overallStep / overallTotal) * 100) : 0;
        const subFill = Math.round(subPct);
        const doneChips = doneSteps.slice(-5).map(s =>
          `<span style="padding:2px 8px;border-radius:999px;background:rgba(76,175,80,.12);color:#2e7d32;font:500 11px 'Inter'">${s}</span>`
        ).join(' ');
        resultEl.innerHTML = `
          <div style="padding:10px 4px 4px">
            <div style="font:600 12px 'Inter';color:var(--md-on-surface);margin-bottom:6px">🔄 Умное выравнивание</div>

            <div style="margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
              <span style="font:400 11px 'Inter';color:var(--md-on-surface-variant)">Общий прогресс</span>
              <span style="font:600 11px 'Inter';color:var(--md-on-surface)">${overallStep} / ${overallTotal} шагов</span>
            </div>
            <div style="height:10px;border-radius:999px;background:var(--md-surface-container-high);overflow:hidden;margin-bottom:10px">
              <div style="height:100%;width:${overallPct}%;background:var(--md-primary);border-radius:999px;transition:width .4s cubic-bezier(.4,0,.2,1)"></div>
            </div>

            <div style="margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
              <span style="font:400 11px 'Inter';color:var(--md-on-surface-variant)">${overallLabel}</span>
              <span style="font:600 11px 'Inter';color:${subFill === 100 ? '#2e7d32' : 'var(--md-secondary)'}">${subFill}%</span>
            </div>
            <div style="height:6px;border-radius:999px;background:var(--md-surface-container-high);overflow:hidden;margin-bottom:8px">
              <div style="height:100%;width:${subFill}%;background:${subFill === 100 ? '#4caf50' : 'var(--md-secondary)'};border-radius:999px;transition:width .15s linear"></div>
            </div>

            ${subLabel ? `<div style="font:400 11px 'Inter';color:var(--md-on-surface-variant);margin-bottom:6px">${subLabel}</div>` : ''}
            ${doneChips ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">${doneChips}</div>` : ''}
          </div>`;
      }

      function startSub(label, expectedMs) {
        overallLabel = label;
        subLabel = '';
        subPct = 0;
        if (subTimer) clearInterval(subTimer);
        const tickMs = 100;
        const totalTicks = Math.max(1, expectedMs / tickMs);
        const perTick = 90 / totalTicks;
        subTimer = setInterval(() => {
          subPct = Math.min(90, subPct + perTick);
          renderBars();
        }, tickMs);
        renderBars();
      }

      function finishSub(detail) {
        if (subTimer) { clearInterval(subTimer); subTimer = null; }
        subPct = 100;
        subLabel = detail || '';
        renderBars();
      }

      renderBars();

      // ═══ ФАЗА 0: СКАНИРОВАНИЕ — загружаем треки + считаем остальные коллекции параллельно ═══
      startSub('Сканируем Firebase...', 5000);
      let tracksData = {};
      const fbCounts = {};
      const fbDataCache = {}; // кэш данных коллекций для последующего импорта

      // Треки грузим полностью (нужны ID и данные для diff), остальные — только подсчёт
      const otherCols = ALIGN_COLS.filter(c => c !== 'tracks');
      const [tracksResult, ...otherResults] = await Promise.all([
        getFirebaseCollectionClean('tracks', 8000),
        ...otherCols.map(col => getFirebaseCollectionClean(col, 4000)),
      ]);
      tracksData = tracksResult || {};
      fbCounts['tracks'] = Object.keys(tracksData).length;
      fbDataCache['tracks'] = tracksData;
      otherCols.forEach((col, i) => {
        const data = otherResults[i] || {};
        fbCounts[col] = Object.keys(data).length;
        fbDataCache[col] = data;
      });
      setFirebaseAvailable(true);
      overallStep = 1;

      // ═══ ФАЗА 1: DIFF — сравниваем с сервером, находим только различия ═══
      finishSub('Сканирование завершено, сравниваем с сервером...');
      await new Promise(r => setTimeout(r, 150));

      const [diffAll, trackDiff] = await Promise.all([
        (async () => {
          try { return await serverPost('/sync/diff-all', { firebaseCounts: fbCounts }); } catch { return null; }
        })(),
        getDiff(Object.keys(tracksData)),
      ]);

      // Определяем какие коллекции реально нуждаются в синхронизации
      // Если diffAll недоступен — синхронизируем только треки (безопасный минимум)
      const colsNeedingSync = ALIGN_COLS.filter(col => {
        if (!diffAll || !diffAll.collections) return col === 'tracks';
        const info = diffAll.collections[col];
        return !info || info.diff > 0;
      });

      const needTrackImport = trackDiff && trackDiff.onlyFirebaseCount > 0;
      const needTrackExport = trackDiff && trackDiff.onlyServerCount > 0;
      const nonTrackCols = colsNeedingSync.filter(c => c !== 'tracks');

      // Если всё синхронизировано
      if (!needTrackImport && !needTrackExport && nonTrackCols.length === 0) {
        window._mpAlignRunning = false;
        if (resultEl) resultEl.innerHTML = `<div style="padding:10px;background:rgba(76,175,80,.08);border-radius:10px;font:400 12px 'Inter'">✅ Всё уже синхронизировано! Различий не найдено.</div>`;
        setTimeout(() => window.MusicDB.showDiff(), 400);
        return;
      }

      // Обновляем динамический total: 1 (скан) + кол-во шагов синхронизации
      const syncSteps = (needTrackImport ? 1 : 0) + (needTrackExport ? 1 : 0) + (nonTrackCols.length > 0 ? 1 : 0);
      overallTotal = 1 + syncSteps;
      renderBars();

      let totalImported = 0;
      let totalSynced = 0;

      // ═══ ФАЗА 2: ТРЕКИ Firebase → Сервер (только недостающие) ═══
      if (needTrackImport) {
        const missingIds = trackDiff.onlyFirebase || [];
        startSub(`Треки FB→Сервер: ${missingIds.length} шт...`, 2000);
        const missingTracks = {};
        for (const id of missingIds) {
          const t = tracksData[id];
          // Пропускаем пустые/сломанные записи без данных
          if (t && (t.title || t.audioUrl || t.artistName)) missingTracks[id] = t;
        }
        try {
          const res = await serverPost('/sync/import-from-firebase', { tracks: missingTracks });
          totalImported += res ? (res.imported || 0) : 0;
          doneSteps.push(`треки FB→S: +${totalImported}`);
          finishSub(`Импортировано треков: +${totalImported}`);
        } catch {
          finishSub('⚠️ Ошибка импорта треков');
        }
        overallStep++;
        await new Promise(r => setTimeout(r, 100));
      }

      // ═══ ФАЗА 3: ТРЕКИ Сервер → Firebase (только недостающие) ═══
      if (needTrackExport) {
        startSub(`Треки Сервер→FB: ${trackDiff.onlyServerCount} шт...`, 3000);
        try {
          const res = await exportServerTracksToFirebase();
          totalSynced = res && !res.error ? (res.synced || 0) : 0;
          doneSteps.push(`треки S→FB: +${totalSynced}`);
          finishSub(res && res.error ? '⚠️ Ошибка' : `Отправлено в Firebase: +${totalSynced}`);
        } catch {
          finishSub('⚠️ Ошибка экспорта');
        }
        overallStep++;
        await new Promise(r => setTimeout(r, 100));
      }

      // ═══ ФАЗА 4: ОСТАЛЬНЫЕ КОЛЛЕКЦИИ (только те где есть разница) ═══
      if (nonTrackCols.length > 0) {
        startSub(`Другие коллекции: ${nonTrackCols.join(', ')}...`, nonTrackCols.length * 1000);
        const toImport = {};
        for (const col of nonTrackCols) {
          toImport[col] = fbDataCache[col] || {};
          doneSteps.push(col);
        }
        try {
          const res = await importAllCollectionsToServer(toImport);
          const cnt = res ? (res.totalImported || 0) : 0;
          totalImported += cnt;
          finishSub(`Коллекции синхронизированы: +${cnt} записей`);
        } catch {
          finishSub('⚠️ Ошибка синхронизации коллекций');
        }
        overallStep++;
        await new Promise(r => setTimeout(r, 100));
      }

      // === Готово ===
      window._mpAlignRunning = false;
      const msg = `✅ Готово. Импортировано: +${totalImported} зап. Синхронизировано: +${totalSynced} треков.`;
      if (isCreator && typeof window.showSnackbar === 'function') window.showSnackbar(msg);
      if (resultEl) resultEl.innerHTML = `<div style="padding:8px;background:rgba(76,175,80,.08);border-radius:10px;font:400 12px 'Inter'">${msg}</div>`;
      setTimeout(() => window.MusicDB.showDiff(), 400);
    },

    openCreatorServicePanel: async function() {
      const status = await getServicesStatus();
      const html = buildServiceStatusHtml(status);
      return html;
    },

    buildServiceStatusHtml,
    getConfig,
    saveConfigRaw: saveConfig,
  };

  window.MusicDB = MusicDB;

  // Глобальная функция удаления ghost-записи из Firebase (и с сервера если есть)
  window._mpDeleteGhostTrack = async function(encodedId) {
    const id = decodeURIComponent(encodedId);
    if (!confirm('Удалить пустую запись "' + id + '" из Firebase и с сервера?')) return;
    const ref = window.firebase && window.firebase.database().ref('tracks/' + id);
    if (!ref) { if (typeof window.showSnackbar === 'function') window.showSnackbar('❌ Firebase не загружена'); return; }
    let fbOk = false;
    try {
      await ref.set(null);
      fbOk = true;
    } catch (e) {
      if (typeof window.showSnackbar === 'function') window.showSnackbar('❌ Firebase ошибка: ' + e.message);
      return;
    }
    // Верификация — читаем узел снова чтобы убедиться что удалился
    await new Promise(r => setTimeout(r, 600));
    try {
      const snap = await ref.once('value');
      if (snap.exists()) {
        if (typeof window.showSnackbar === 'function') window.showSnackbar('❌ Не удалось удалить — проверь Firebase Rules');
        return;
      }
    } catch (_) {}
    // Также удаляем с сервера если там тоже есть эта запись
    try { await serverDelete('/tracks/' + encodeURIComponent(id)); } catch (_) {}
    if (typeof window.showSnackbar === 'function') window.showSnackbar('✅ Удалено из Firebase' + (fbOk ? ' и сервера' : ''));
    window.MusicDB.showDiff();
  };

  // Глобальная функция удаления записи с сервера (для треков только на сервере)
  window._mpDeleteServerTrack = async function(encodedId) {
    const id = decodeURIComponent(encodedId);
    if (!confirm('Удалить "' + id + '" с сервера?\n\nЕсли это реальный трек — сначала выровняй данные чтобы не потерять его.')) return;
    try {
      const r = await serverDelete('/tracks/' + encodeURIComponent(id));
      if (r && r.ok === false) throw new Error(r.error || 'Сервер отказал');
    } catch (e) {
      if (typeof window.showSnackbar === 'function') window.showSnackbar('❌ Ошибка: ' + e.message);
      return;
    }
    if (typeof window.showSnackbar === 'function') window.showSnackbar('✅ Удалено с сервера');
    window.MusicDB.showDiff();
  };

  /* ===== ПАТЧИМ ФУНКЦИИ ЗАГРУЗКИ ТРЕКОВ ===== */
  function patchUploadFunction() {
    const origSubmit = window.submitUpload;
    if (!origSubmit) return;

    window.submitUpload = async function(...args) {
      const trackRef_original = window._origDbRefPush;
      return origSubmit.apply(this, args);
    };
  }

  /* ===== ЗЕРКАЛИРУЕМ FIREBASE ЗАПИСЬ НА СЕРВЕР ===== */
  const MIRRORED_COLLECTIONS = new Set([
    'tracks', 'users', 'usernames', 'emails',
    'favorites', 'playlists', 'pinnedTracks',
    'subscriptions', 'subscribers',
    'history', 'notifications',
    'reports', 'trackVideoData',
  ]);

  function parseFirebasePath(fbPath) {
    if (!fbPath || typeof fbPath !== 'string') return null;
    const parts = fbPath.replace(/^\//, '').split('/');
    const collection = parts[0];
    if (!MIRRORED_COLLECTIONS.has(collection)) return null;
    const id = parts[1] || null;
    const subKey = parts.slice(2).join('/') || null;
    return { collection, id, subKey };
  }

  function mirrorToServer(fbPath, action, data) {
    const p = parseFirebasePath(fbPath);
    if (!p || !p.id) return;
    const { collection, id, subKey } = p;

    checkServerAvailable().then(ok => {
      if (!ok) {
        addToLocalQueue({ collection, docId: id, subKey, action, data });
        return;
      }
      const apiBase = '/db/' + collection + '/' + encodeURIComponent(id);
      try {
        if (action === 'set') {
          const url = subKey ? apiBase + '/' + encodeURIComponent(subKey) : apiBase;
          serverPost(url, data || {}).catch(() => {
            addToLocalQueue({ collection, docId: id, subKey, action, data });
          });
        } else if (action === 'update') {
          const url = subKey ? apiBase + '/' + encodeURIComponent(subKey) : apiBase;
          serverPatch(url, data || {}).catch(() => {
            addToLocalQueue({ collection, docId: id, subKey, action, data });
          });
        } else if (action === 'remove') {
          const url = subKey ? apiBase + '/' + encodeURIComponent(subKey) : apiBase;
          serverDelete(url).catch(() => {});
        }
      } catch (e) {
        console.warn('[MusicDB] mirror error', e.message);
      }
    });
  }

  function patchRefObject(ref, resolvedPath) {
    const origSet = ref.set.bind(ref);
    const origUpdate = ref.update ? ref.update.bind(ref) : null;
    const origRemove = ref.remove ? ref.remove.bind(ref) : null;

    ref.set = function(data, ...rest) {
      mirrorToServer(resolvedPath, 'set', data);
      return origSet(data, ...rest);
    };

    if (origUpdate) {
      ref.update = function(data, ...rest) {
        mirrorToServer(resolvedPath, 'update', data);
        return origUpdate(data, ...rest);
      };
    }

    if (origRemove) {
      ref.remove = function(...rest) {
        mirrorToServer(resolvedPath, 'remove', null);
        return origRemove(...rest);
      };
    }

    return ref;
  }

  /* ===== ПЕРЕХВАТЫВАЕМ ВСЕ db.ref() ВЫЗОВЫ ===== */
  function patchFirebaseDb() {
    if (!window.firebase || !window.firebase.database) return;
    const db = window.firebase.database();
    if (db.__musicdbPatched) return;
    db.__musicdbPatched = true;

    const origRef = db.ref.bind(db);
    db.ref = function(fbPath) {
      const ref = origRef(fbPath);
      const parsed = parseFirebasePath(fbPath);

      if (parsed) {
        if (parsed.id) {
          patchRefObject(ref, fbPath);
        } else {
          const origPush = ref.push.bind(ref);
          ref.push = function(data) {
            const newRef = origPush(data);
            const pushedPath = fbPath + '/' + newRef.key;
            patchRefObject(newRef, pushedPath);
            return newRef;
          };

          const origChild = ref.child ? ref.child.bind(ref) : null;
          if (origChild) {
            ref.child = function(childPath) {
              const childRef = origChild(childPath);
              const fullPath = fbPath + '/' + childPath;
              patchRefObject(childRef, fullPath);
              return childRef;
            };
          }
        }
      }

      return ref;
    };

    console.log('[MusicDB] Firebase db.ref patched — зеркалирование на сервер активно');
  }

  /* ===== РЕАЛЬНОЕ ПЕРЕКЛЮЧЕНИЕ ИСТОЧНИКА ДАННЫХ ===== */
  function applySourceSwitch(cfg) {
    const src = (cfg || { ...defaultConfig, ...getConfig() }).primarySource;
    if (src !== 'server') {
      // Firebase или auto — разблокируем Firebase listener и обновляем чип
      window._mpServerModeLocked = false;
      updateDataSourceChip(src || 'firebase');
      return;
    }
    // Загружаем треки с сервера и передаём через custom event (window.allTracks — не то же что let allTracks в index.html)
    loadTracksFromServer().then(serverTracks => {
      if (!serverTracks || Object.keys(serverTracks).length === 0) return;
      window._mpServerModeLocked = true; // блокируем Firebase-override allTracks
      window.dispatchEvent(new CustomEvent('mp-source-switch', { detail: { source: 'server', tracks: serverTracks } }));
      updateDataSourceChip('server');
      console.log('[MusicDB] Source switched to SERVER — loaded', Object.keys(serverTracks).length, 'tracks');
    }).catch(e => console.warn('[MusicDB] applySourceSwitch failed:', e.message));
  }

  // Инициализируем значок при старте
  setTimeout(() => {
    const src = ({ ...defaultConfig, ...getConfig() }).primarySource;
    updateDataSourceChip(src || 'firebase');
  }, 2600);

  /* ===== ИНДИКАТОР ИСТОЧНИКА ДАННЫХ (в панели источников) ===== */
  function updateDataSourceChip(src) {
    const badge = document.getElementById('mpActiveSourceBadge');
    if (!badge) return;
    const isServer = src === 'server';
    const isAuto = src === 'auto';
    badge.style.background = isServer ? 'rgba(25,118,210,.15)' : isAuto ? 'rgba(76,175,80,.15)' : 'rgba(251,140,0,.15)';
    badge.style.color = isServer ? '#1565c0' : isAuto ? '#2e7d32' : '#e65100';
    badge.textContent = isServer ? '🖥 Сервер активен' : isAuto ? '🔄 Авто' : '🔥 Firebase активен';
  }

  /* ===== ПАТЧ ПАНЕЛИ СОЗДАТЕЛЯ ===== */
  function patchCreatorPanel() {
    // Заменяем фейковую openCreatorModuleCheck на реальную
    window.openCreatorModuleCheck = async function() {
      if (typeof window.creatorPanelWrap !== 'function') return;
      window.creatorPanelWrap('Проверка сервисов', '<div class="loading-spinner" style="margin:20px auto"></div>');
      
      const status = await getServicesStatus();
      const srv = status.server;
      const fb = status.firebase;
      const q = status.syncQueue;

      function badge(s) {
        const colors = { ok: '#18a957', offline: '#e53935', error: '#e53935', timeout: '#f59e0b', checking: '#888', 'not-loaded': '#f59e0b', external: '#888' };
        const labels = { ok: 'Работает', offline: 'Офлайн', error: 'Ошибка', timeout: 'Таймаут', checking: 'Проверка...', 'not-loaded': 'Не загружен', external: 'Внешний' };
        const c = colors[s] || '#888';
        return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:999px;background:${c}22;color:${c};font:700 11px 'Inter'">${labels[s] || s}</span>`;
      }
      function latencyBadge(ms) {
        if (ms === null) return '';
        const c = ms < 200 ? '#18a957' : ms < 600 ? '#f59e0b' : '#e53935';
        return `<span style="font:400 11px 'Inter';color:${c}">⚡ ${ms}мс</span>`;
      }

      const serverDetail = srv.details ? srv.details.server || {} : {};
      const dbDetail = srv.details ? srv.details.database || {} : {};

      const rows = [
        {
          icon: 'dns',
          name: '🖥️ Сервер',
          statusBadge: badge(srv.status),
          latency: latencyBadge(srv.latencyMs),
          extra: [
            serverDetail.uptimeFormatted ? 'Аптайм: ' + serverDetail.uptimeFormatted : '',
            dbDetail.tracks !== undefined ? 'Треков: ' + dbDetail.tracks : '',
            dbDetail.users !== undefined ? 'Пользователей: ' + dbDetail.users : '',
            serverDetail.memoryUsedMb ? 'RAM: ' + serverDetail.memoryUsedMb + ' МБ' : '',
          ].filter(Boolean).join(' • '),
        },
        {
          icon: 'local_fire_department',
          name: '🔥 Firebase Realtime DB',
          statusBadge: badge(fb.status),
          latency: latencyBadge(fb.latencyMs),
          extra: 'Роль: резервная (fallback)',
        },
        {
          icon: 'sync',
          name: '🔄 Очередь синхронизации',
          statusBadge: q.pending > 0 ? badge('timeout') : badge('ok'),
          latency: '',
          extra: 'Ожидает отправки в Firebase: ' + q.pending + ' из ' + q.total,
        },
        {
          icon: 'play_circle',
          name: '🎵 Плеер',
          statusBadge: badge('ok'),
          extra: 'Встроенный HTML5 Audio',
        },
        {
          icon: 'policy',
          name: '🤖 ИИ-модерация',
          statusBadge: badge('ok'),
          extra: 'Pollinations AI + фоновый анализ',
        },
        {
          icon: 'radio',
          name: '📻 Радио',
          statusBadge: badge('ok'),
          extra: 'Встроенный каталог российского радио',
        },
        {
          icon: 'celebration',
          name: '🎉 Party Mode',
          statusBadge: (typeof window.partySessionId !== 'undefined' && window.partySessionId) ? badge('ok') : badge('checking'),
          extra: (typeof window.partySessionId !== 'undefined' && window.partySessionId) ? 'Активная вечеринка' : 'Готов к запуску',
        },
        {
          icon: 'search',
          name: '🔍 Поиск',
          statusBadge: badge('ok'),
          extra: 'Локальный поиск по загруженным трекам',
        },
      ];

      const refreshBtn = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button class="btn-tonal" onclick="window.openCreatorModuleCheck()" style="padding:6px 14px;font-size:13px">
          <span class="material-symbols-rounded" style="font-size:15px">refresh</span> Обновить
        </button>
      </div>`;

      const html = refreshBtn + rows.map(row => `
        <div class="settings-item">
          <span class="material-symbols-rounded">${row.icon}</span>
          <div class="settings-item-info">
            <div class="settings-item-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              ${row.name} ${row.statusBadge || ''} ${row.latency || ''}
            </div>
            ${row.extra ? `<div class="settings-item-sub">${row.extra}</div>` : ''}
          </div>
        </div>
      `).join('');

      window.creatorPanelWrap('Проверка сервисов', html);
    };

    // Добавляем пункт "Источники данных" в меню создателя
    const origOpenAdminTools = window.openAdminTools;
    if (origOpenAdminTools) {
      window.openAdminTools = function() {
        origOpenAdminTools.call(this);
        // Добавляем новый пункт в settingsContent
        setTimeout(() => {
          const content = document.getElementById('settingsContent');
          if (!content) return;
          const actions = content.querySelector('.modal-actions');
          if (!actions) return;
          const newItem = document.createElement('div');
          newItem.className = 'settings-item';
          newItem.style.cursor = 'pointer';
          newItem.onclick = window.MusicDB.openCreatorDataSourcePanel;
          newItem.innerHTML = `
            <span class="material-symbols-rounded">storage</span>
            <div class="settings-item-info">
              <div class="settings-item-title">Источники данных</div>
              <div class="settings-item-sub">Сервер vs Firebase, выравнивание, очередь синхронизации</div>
            </div>
            <span class="material-symbols-rounded" style="color:var(--md-outline)">chevron_right</span>
          `;
          content.insertBefore(newItem, actions);
        }, 50);
      };
    }
  }

  /* ===== ПАНЕЛЬ ИСТОЧНИКОВ ДАННЫХ ===== */
  MusicDB.openCreatorDataSourcePanel = async function() {
    if (typeof window.creatorPanelWrap !== 'function') {
      alert('Функция доступна только в панели создателя');
      return;
    }
    window.creatorPanelWrap('Источники данных', '<div class="loading-spinner" style="margin:20px auto"></div>');
    const status = await getServicesStatus();
    const refreshBtn = `<div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button class="btn-tonal" onclick="window.MusicDB.openCreatorDataSourcePanel()" style="padding:6px 14px;font-size:13px">
        <span class="material-symbols-rounded" style="font-size:15px">refresh</span> Обновить
      </button>
    </div>`;
    const html = refreshBtn + buildServiceStatusHtml(status);
    window.creatorPanelWrap('Источники данных', html);
  };

  /* ===== РАСШИРЕННЫЕ LABS ФУНКЦИИ ===== */
  function patchLabsModal() {
    const LABS_ITEMS = [
      {
        key: 'videoInsteadOfCover',
        icon: 'smart_display',
        title: 'Видео вместо обложки',
        sub: 'В полноэкранном плеере вместо обложки показывается видео трека, если оно есть. Экспериментально.'
      },
      {
        key: 'customIcons',
        icon: 'auto_awesome',
        title: 'Кастомные иконки',
        sub: 'Переключает иконки платформы в заполненный стиль (filled) — более яркий и насыщенный внешний вид.',
        onToggle: function(val) {
          if (typeof window.applyLabsCustomIcons === 'function') window.applyLabsCustomIcons(val);
        }
      },
    ];

    window.renderLabsModal = function() {
      const grid = document.getElementById('labsGrid');
      if (!grid) return;
      const ls = window.labsSettings || {};
      grid.innerHTML = LABS_ITEMS.map(item => `
        <div class="labs-card">
          <div class="labs-card-title">
            <span class="material-symbols-rounded">${item.icon}</span>${item.title}
          </div>
          <div class="labs-card-sub">${item.sub}</div>
          <div class="effect-row" style="margin:0">
            <div class="effect-meta">
              <div class="effect-sub" style="font:500 11px 'Inter';color:${ls[item.key] ? 'var(--md-primary)' : 'var(--md-on-surface-variant)'}">
                ${ls[item.key] ? 'Включено' : 'Выключено'}
              </div>
            </div>
            <div class="toggle ${ls[item.key] ? 'on' : ''}" onclick="window.__mpToggleLab('${item.key}')"></div>
          </div>
        </div>
      `).join('');
    };

    window.__mpToggleLab = function(key) {
      if (!window.labsSettings) window.labsSettings = {};
      window.labsSettings[key] = !window.labsSettings[key];
      try {
        localStorage.setItem('mp_labs_settings', JSON.stringify(window.labsSettings));
      } catch {}
      const item = LABS_ITEMS.find(i => i.key === key);
      if (item && item.onToggle) item.onToggle(window.labsSettings[key]);
      if (key === 'adaptiveTheme' && window.labsSettings[key]) {
        if (typeof window.setAdaptiveThemeMode === 'function') window.setAdaptiveThemeMode('device');
      }
      if (key === 'compactTrackList') {
        document.body.classList.toggle('compact-tracks', !!window.labsSettings[key]);
      }
      if (key === 'waveformEnabled') {
        document.body.classList.toggle('wave-anim', !!window.labsSettings[key]);
      }
      if (key === 'colorfulAvatars') {
        document.body.classList.toggle('colorful-avatars', !!window.labsSettings[key]);
      }
      if (typeof window.renderLabsModal === 'function') window.renderLabsModal();
    };

    const style = document.createElement('style');
    style.textContent = `
      body.compact-tracks .track-item{padding:4px 12px!important}
      body.compact-tracks .track-thumb{width:36px!important;height:36px!important}
      body.wave-anim .now-playing-mark::after{content:'';display:inline-block;width:14px;height:14px;border-radius:50%;background:var(--md-primary);animation:waveBeat .8s ease-in-out infinite;margin-left:4px;vertical-align:middle}
      @keyframes waveBeat{0%,100%{transform:scale(.6);opacity:.5}50%{transform:scale(1);opacity:1}}
      body.colorful-avatars .user-avatar:not(:has(img)){background:linear-gradient(135deg,var(--md-primary),var(--md-tertiary))!important}
    `;
    document.head.appendChild(style);
  }

  /* ===== УЛУЧШЕННАЯ МОДЕРАЦИЯ ===== */
  function patchModeration() {
    const origModerate = window.moderateTrackWithAI;
    if (!origModerate) return;

    window.moderateTrackWithAI = async function(opts) {
      try {
        const result = await origModerate(opts);
        if (result) {
          result._serverMirror = true;
          if (!result.updatedAt) result.updatedAt = Date.now();
          if (result.transcript && !result.transcript.startsWith('[')) {
            result.displayLyrics = result.transcript;
          }
        }
        return result;
      } catch(e) {
        console.warn('[MusicDB] Moderation fallback:', e.message);
        return {
          isExplicit: false,
          reason: 'Модерация временно недоступна — трек опубликован без проверки',
          displayLyrics: opts.lyrics || '',
          transcript: opts.lyrics || '',
          updatedAt: Date.now(),
          moderationModel: 'fallback',
          copyrightPossible: false,
          copyrightConfidence: 0,
          copyrightReason: 'Проверка авторских прав пропущена',
          copyrightMatchedSource: '',
          copyrightMatchedArtist: '',
          copyrightModel: 'fallback',
        };
      }
    };

    const origTranscribe = window.transcribeAudioWithPollinations;
    if (origTranscribe) {
      window.transcribeAudioWithPollinations = async function(file, opts) {
        try {
          const result = await origTranscribe(file, opts);
          return result;
        } catch(e) {
          console.warn('[MusicDB] Transcription failed, using empty:', e.message);
          return { text: '', error: e.message };
        }
      };
    }
  }

  /* ===== УЛУЧШЕНИЕ ПАНЕЛИ СОЗДАТЕЛЯ ===== */
  function patchAdminPanelDisplay() {
    const origCreatorStats = window.openCreatorStats;
    if (origCreatorStats) {
      window.openCreatorStats = async function() {
        origCreatorStats.call(this);
        setTimeout(async () => {
          try {
            const ok = await checkServerAvailable();
            if (!ok) return;
            const status = await serverGet('/admin/status');
            const content = document.getElementById('settingsContent');
            if (!content || !status.ok) return;
            const db = status.database || {};
            const srv = status.server || {};
            const serverInfo = document.createElement('div');
            serverInfo.style.cssText = 'margin:12px 0;padding:12px 14px;border-radius:14px;background:var(--md-surface-container);border:1px solid var(--md-outline-variant)';
            serverInfo.innerHTML = `
              <div style="font:700 13px 'Inter';color:var(--md-on-surface);margin-bottom:8px">🖥️ Сервер (реальные данные)</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div style="font:400 12px 'Inter';color:var(--md-on-surface-variant)">Треков на сервере: <b style="color:var(--md-primary)">${db.tracks ?? '—'}</b></div>
                <div style="font:400 12px 'Inter';color:var(--md-on-surface-variant)">Пользователей: <b style="color:var(--md-primary)">${db.users ?? '—'}</b></div>
                <div style="font:400 12px 'Inter';color:var(--md-on-surface-variant)">Аптайм: <b>${srv.uptimeFormatted ?? '—'}</b></div>
                <div style="font:400 12px 'Inter';color:var(--md-on-surface-variant)">RAM: <b>${srv.memoryUsedMb ? srv.memoryUsedMb + ' МБ' : '—'}</b></div>
                <div style="font:400 12px 'Inter';color:var(--md-on-surface-variant)">Обновлено: <b>${new Date().toLocaleTimeString('ru-RU')}</b></div>
              </div>
            `;
            const title = content.querySelector('.modal-title');
            if (title) title.after(serverInfo);
          } catch {}
        }, 200);
      };
    }

  }

  /* ===== ИНИЦИАЛИЗАЦИЯ ===== */
  async function init() {
    console.log('[MusicDB] Initializing...');

    setTimeout(async () => {
      patchFirebaseDb();
    }, 500);

    setTimeout(backgroundSyncLoop, 3000);

    const ok = await checkServerAvailable();
    console.log('[MusicDB] Server available:', ok, '| URL:', SERVER_BASE);
    if (ok) {
      try {
        const configRes = await serverGet('/sync/config');
        if (configRes.ok && configRes.config) {
          const existing = getConfig();
          if (!existing.primarySource) {
            saveConfig(configRes.config);
          }
        }
      } catch { /* ignore */ }
    }

    setTimeout(patchCreatorPanel, 800);
    setTimeout(patchLabsModal, 1000);
    setTimeout(patchModeration, 600);
    setTimeout(patchAdminPanelDisplay, 1200);
    // Применяем выбранный источник данных при запуске
    setTimeout(() => applySourceSwitch(), 2000);

    console.log('[MusicDB] Ready. Server:', ok ? 'online' : 'offline');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
