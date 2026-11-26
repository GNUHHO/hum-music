'use strict';
// Hum for iPhone: plays your own music straight from Google Drive while you listen.
// A song is downloaded into memory only while it plays (plus the next one, so songs change
// smoothly with the screen locked). Nothing is written to the phone's storage except the song
// list, likes, playlists and the Google sign-in.

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav' };
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');

// ── storage ──
const S = {
  get(k, d) { try { const v = localStorage.getItem('hum.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hum.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('hum.' + k); } catch {} },
};

// Test hook: on this computer only, ?api=http://127.0.0.1:PORT points Hum at a stand-in Google server.
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
if (LOCAL) { const a = new URLSearchParams(location.search).get('api'); if (a) S.set('devApi', a); }
const DEV = LOCAL ? S.get('devApi', null) : null;
const EP = DEV
  ? { auth: DEV + '/auth', token: DEV + '/token', revoke: DEV + '/revoke', drive: DEV + '/drive/v3' }
  : { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke', drive: 'https://www.googleapis.com/drive/v3' };

// ── errors ──
class NetError extends Error { constructor() { super("No internet — can't reach Google Drive"); } }
class AuthError extends Error { constructor() { super('Google Drive sign-in expired — sign in again'); } }
class GoneError extends Error { constructor() { super('Not on Google Drive anymore'); } }
const isAbort = e => e && e.name === 'AbortError';

// ── state ──
let drive = S.get('drive', null);          // { clientId, secret, refresh, folderId, folderName }
let access = S.get('access', null);        // { tok, exp }
let lib = new Map((S.get('lib', [])).map(t => [t.id, t]));
let liked = S.get('liked', []);            // track ids, newest first
let playlists = S.get('playlists', []);    // [{ id, name, ids }]
let prefs = Object.assign({ shuffle: false, repeat: 0 }, S.get('prefs', {})); // repeat: 0 off, 1 all, 2 one
let view = S.get('view', 'library');
let query = '';
let shown = [];                            // tracks in the open list, in order
let sorted = null;                         // library sorted by title (cache)
let syncing = false, syncAgain = false, lastSync = 0;

const saveLib = () => S.set('lib', [...lib.values()]);
const saveLiked = () => S.set('liked', liked);
const savePlaylists = () => S.set('playlists', playlists);
const savePrefs = () => S.set('prefs', prefs);
const saveDrive = () => S.set('drive', drive);

// ── helpers ──
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const extOf = n => { const m = /\.([^.]+)$/.exec(n || ''); return m ? m[1].toLowerCase() : ''; };
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const coll = new Intl.Collator('vi', { sensitivity: 'base', numeric: true });
const fmt = s => { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); };
const hue = s => { let h = 0; for (const c of s || '') h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; };
const letter = s => (Array.from((s || '?').trim())[0] || '?').toUpperCase();
const sub = t => [t.artist, t.album].filter(Boolean).join(' · ') || 'Google Drive';
const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };
const b64url = a => btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const P = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="currentColor" ${extra}>${d}</svg>`;
const L = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const HEART = 'M12 20.3s-7.4-4.6-9.5-9.3A5.2 5.2 0 0 1 12 6.1a5.2 5.2 0 0 1 9.5 4.9c-2.1 4.7-9.5 9.3-9.5 9.3z';
const I = {
  play: P('<path d="M8 5.4v13.2a1 1 0 0 0 1.5.86l10.7-6.6a1 1 0 0 0 0-1.72L9.5 4.54A1 1 0 0 0 8 5.4z"/>'),
  pause: P('<rect x="6" y="5" width="4.2" height="14" rx="1.2"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.2"/>'),
  next: P('<path d="M5.5 6.1v11.8a.9.9 0 0 0 1.4.75l8.6-5.9a.9.9 0 0 0 0-1.5L6.9 5.35a.9.9 0 0 0-1.4.75z"/><rect x="16.3" y="5.3" width="2.4" height="13.4" rx="1.2"/>'),
  prev: P('<path d="M18.5 6.1v11.8a.9.9 0 0 1-1.4.75l-8.6-5.9a.9.9 0 0 1 0-1.5l8.6-5.9a.9.9 0 0 1 1.4.75z"/><rect x="5.3" y="5.3" width="2.4" height="13.4" rx="1.2"/>'),
  heart: L(`<path d="${HEART}"/>`),
  heartFill: P(`<path d="${HEART}"/>`),
  more: P('<circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/>'),
  shuffle: L('<path d="M3 7h3c2.2 0 3.4 1.1 4.6 3l2.8 4c1.2 1.9 2.4 3 4.6 3h3M3 17h3c1.5 0 2.5-.5 3.4-1.4M14.6 8.4c.9-.9 1.9-1.4 3.4-1.4h3M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5"/>'),
  repeat: L('<path d="M17 3l3 3-3 3M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M7 21l-3-3 3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4"/>'),
  repeat1: L('<path d="M17 3l3 3-3 3M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M7 21l-3-3 3-3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4"/><path d="M11 10.5l1.4-1v5" stroke-width="1.7"/>'),
  down: L('<path d="M6 9l6 6 6-6"/>'),
  back: L('<path d="M15 5l-7 7 7 7"/>'),
  search: L('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
  library: L('<path d="M5 4v16M10 4v16M14.5 4.6l4.6 15"/>'),
  playlists: L('<path d="M4 6h12M4 11.5h12M4 17h7M18 13v8M14 17h8"/>'),
  list: L('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
  plus: L('<path d="M12 5v14M5 12h14"/>'),
};

// ── tags (ID3v2 for mp3/aac, Vorbis comments for flac), read from the first 64 KB ──
function readTags(t, buf) {
  const b = new Uint8Array(buf), r = {}, x = extOf(t.name);
  try { if (x === 'mp3' || x === 'aac') id3(b, r); else if (x === 'flac') flac(b, r); } catch {}
  finishTags(t, r);
}
const ss = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const asc = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const parseNo = s => { const m = /^\s*(\d{1,4})/.exec(s || ''); return m ? +m[1] : 0; };
const dec = (enc, b) => { try { return new TextDecoder(enc).decode(b); } catch { return ''; } };

function id3(b, r) {
  if (b.length < 10 || asc(b, 0, 3) !== 'ID3') return;
  const ver = b[3], flags = b[5], size = ss(b, 6);
  if (size <= 0) return;
  let buf = b.subarray(10, Math.min(b.length, 10 + size));
  if ((flags & 0x80) && ver < 4) {
    const o = [];
    for (let i = 0; i < buf.length; i++) { o.push(buf[i]); if (buf[i] === 0xff && buf[i + 1] === 0) i++; }
    buf = Uint8Array.from(o);
  }
  const n = buf.length;
  let pos = 0;
  if ((flags & 0x40) && ver >= 3 && n >= 4) pos = ver === 4 ? ss(buf, 0) : be32(buf, 0) + 4;
  while (pos >= 0 && pos < n) {
    let id, fsz, hdr;
    if (ver === 2) { if (pos + 6 > n) break; id = asc(buf, pos, 3); fsz = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5]; hdr = 6; }
    else { if (pos + 10 > n) break; id = asc(buf, pos, 4); fsz = ver === 4 ? ss(buf, pos + 4) : be32(buf, pos + 4); hdr = 10; }
    if (buf[pos] === 0 || fsz <= 0 || pos + hdr + fsz > n) break;
    const v = () => id3text(buf.subarray(pos + hdr, pos + hdr + fsz));
    switch (id) {
      case 'TIT2': case 'TT2': r.title = v(); break;
      case 'TPE1': case 'TP1': r.artist = v(); break;
      case 'TPE2': case 'TP2': r.albumArtist = v(); break;
      case 'TALB': case 'TAL': r.album = v(); break;
      case 'TRCK': case 'TRK': r.no = parseNo(v()); break;
    }
    pos += hdr + fsz;
  }
}

function id3text(b) {
  if (b.length < 2) return '';
  const enc = b[0], d = b.subarray(1);
  let s;
  if (enc === 1) {
    if (d[0] === 0xfe && d[1] === 0xff) s = dec('utf-16be', d.subarray(2));
    else if (d[0] === 0xff && d[1] === 0xfe) s = dec('utf-16le', d.subarray(2));
    else s = dec('utf-16le', d);
  } else if (enc === 2) s = dec('utf-16be', d);
  else if (enc === 3) s = dec('utf-8', d);
  else s = dec('latin1', d);
  const z = s.indexOf('\0');
  return (z >= 0 ? s.slice(0, z) : s).trim();
}

function flac(b, r) {
  if (b.length < 8 || asc(b, 0, 4) !== 'fLaC') return;
  let p = 4;
  while (p + 4 <= b.length) {
    const last = b[p] & 0x80, type = b[p] & 0x7f, len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    p += 4;
    if (type === 4) {
      const end = Math.min(b.length, p + len);
      let q = p + 4 + le32(b, p);
      if (q + 4 > end) return;
      const cnt = le32(b, q); q += 4;
      for (let i = 0; i < cnt && q + 4 <= end; i++) {
        const l = le32(b, q); q += 4;
        if (q + l > end) break;
        const kv = dec('utf-8', b.subarray(q, q + l)); q += l;
        const eq = kv.indexOf('=');
        if (eq <= 0) continue;
        const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1);
        if (k === 'TITLE' && !r.title) r.title = v;
        else if (k === 'ARTIST' && !r.artist) r.artist = v;
        else if (k === 'ALBUMARTIST') r.albumArtist = v;
        else if (k === 'ALBUM' && !r.album) r.album = v;
        else if (k === 'TRACKNUMBER') r.no = parseNo(v);
      }
      return;
    }
    if (last) return;
    p += len;
  }
}

// Same rules as Hum on Windows: tags first, else "Artist - Title" / "01 - Title" from the file name.
function finishTags(t, r) {
  const clean = s => (s || '').replace(/[\t\r\n]/g, ' ').trim();
  let title = clean(r.title), artist = clean(r.artist) || clean(r.albumArtist), album = clean(r.album), no = r.no || 0;
  if (!title) {
    let n = t.name.replace(/\.[^.]+$/, '');
    const i = n.indexOf(' - ');
    if (i > 0) {
      const left = n.slice(0, i).trim();
      if (/^\d+$/.test(left)) { if (!no) no = +left; }
      else if (!artist) artist = left;
      n = n.slice(i + 3);
    }
    title = n.trim();
  }
  Object.assign(t, { title: clean(title), artist, album, no });
}

// ── Google sign-in (OAuth with PKCE; Google returns to this page) ──
async function signIn(clientId, secret, folderId) {
  const verifier = rand(48), state = rand(18);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  S.set('pending', { clientId, secret, folderId, verifier, state });
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state,
  });
  location.href = EP.auth + '?' + p;
}

async function finishSignIn(q) {
  const pend = S.get('pending', null);
  S.del('pending');
  history.replaceState(null, '', REDIRECT);
  const fail = msg => { showSetup(msg, true, pend); return false; };
  if (q.get('error')) return fail(q.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : `Google didn't accept the sign-in (${q.get('error')}).`);
  if (!pend || pend.state !== q.get('state')) return fail('Sign-in got mixed up. Try again.');
  let r, j;
  try {
    r = await fetch(EP.token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: q.get('code'), client_id: pend.clientId, client_secret: pend.secret, redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: pend.verifier }),
    });
    j = await r.json().catch(() => ({}));
  } catch { return fail("No internet — can't reach Google."); }
  if (!r.ok || !j.refresh_token) {
    const why = j.error === 'invalid_client' ? 'Check the Client ID and Client secret.' : (j.error_description || j.error || 'error ' + r.status);
    return fail("Google didn't accept the sign-in. " + why);
  }
  const old = drive;
  drive = { clientId: pend.clientId, secret: pend.secret, refresh: j.refresh_token, folderId: pend.folderId || '', folderName: '' };
  access = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  S.set('access', access);
  if (drive.folderId) {
    try { drive.folderName = await folderName(drive.folderId); }
    catch (e) { drive = old; saveDrive(); return fail(e.message); }
  }
  if (old && old.folderId !== drive.folderId) { lib = new Map(); sorted = null; saveLib(); }
  saveDrive();
  return true;
}

let tokP = null;
function token(force) {
  if (!drive || !drive.refresh) return Promise.reject(new AuthError());
  if (!force && access && Date.now() < access.exp - 60000) return Promise.resolve(access.tok);
  if (tokP) return tokP;
  tokP = (async () => {
    let r;
    try {
      r = await fetch(EP.token, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: drive.clientId, client_secret: drive.secret, refresh_token: drive.refresh, grant_type: 'refresh_token' }),
      });
    } catch { throw new NetError(); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      if (r.status === 400 || r.status === 401) { authLost(); throw new AuthError(); }
      throw new Error(`Google sign-in failed (error ${r.status})`);
    }
    access = { tok: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    S.set('access', access);
    return access.tok;
  })().finally(() => { tokP = null; });
  return tokP;
}

async function api(path, opts = {}, retried = false) {
  const tok = await token(retried);
  let r;
  try { r = await fetch(EP.drive + path, Object.assign({}, opts, { headers: Object.assign({}, opts.headers, { Authorization: 'Bearer ' + tok }) })); }
  catch (e) { if (isAbort(e)) throw e; throw new NetError(); }
  if (r.status === 401) {
    if (!retried) return api(path, opts, true);
    authLost(); throw new AuthError();
  }
  if (r.status === 403) {
    const j = await r.json().catch(() => ({}));
    const m = (j.error && j.error.message) || '';
    if (/has not been used|is disabled/i.test(m)) throw new Error('The Google Drive API is turned off in your Google Cloud project. Turn it on (step 2 of the guide).');
    throw new Error('Google Drive refused: ' + (m || 'error 403'));
  }
  return r;
}

function authLost() {
  if (drive && drive.refresh) { drive.refresh = null; saveDrive(); }
  access = null; S.del('access');
  renderBanner();
}

// ── Drive ──
function parseFolderId(input) {
  input = (input || '').trim();
  if (!input) return '';
  const i = input.toLowerCase().indexOf('/folders/');
  if (i >= 0) input = input.slice(i + 9);
  else if (/drive\.google\.com/i.test(input)) {
    const q = input.toLowerCase().indexOf('id=');
    if (q < 0) return null;
    input = input.slice(q + 3);
  }
  input = input.split(/[?/&#]/)[0];
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : null;
}

async function folderName(id) {
  const r = await api(`/files/${encodeURIComponent(id)}?fields=name,mimeType&supportsAllDrives=true`);
  if (r.status === 404) throw new Error("Can't find that folder. Check the link, and that it's in the Google account you signed in with.");
  if (!r.ok) throw new Error(`Google Drive error ${r.status}`);
  const j = await r.json();
  if (j.mimeType !== 'application/vnd.google-apps.folder') throw new Error("That link isn't a folder.");
  return j.name || 'Folder';
}

async function listQuery(q, each) {
  let page = '';
  do {
    const p = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
    if (page) p.set('pageToken', page);
    const r = await api('/files?' + p);
    if (!r.ok) throw new Error(`Google Drive error ${r.status}`);
    const j = await r.json();
    (j.files || []).forEach(each);
    page = j.nextPageToken || '';
  } while (page);
}

async function listMusic() {
  const out = [], add = f => { if (TYPES[extOf(f.name)]) out.push(f); };
  if (drive.folderId) {
    const todo = [drive.folderId], seen = new Set(todo);
    while (todo.length) {
      const id = todo.shift();
      await listQuery(`'${id}' in parents and trashed=false`, f => {
        if (f.mimeType === 'application/vnd.google-apps.folder') { if (!seen.has(f.id)) { seen.add(f.id); todo.push(f.id); } }
        else add(f);
      });
    }
  } else await listQuery("mimeType contains 'audio/' and trashed=false", add);
  return out;
}

async function sync() {
  if (!drive || !drive.refresh) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; lastSync = Date.now(); renderHead();
  try {
    const files = await listMusic();
    const next = new Map();
    for (const f of files) {
      const o = lib.get(f.id);
      if (o && o.mod === f.modifiedTime && o.tagged) { o.name = f.name; next.set(f.id, o); continue; }
      const t = { id: f.id, name: f.name, mod: f.modifiedTime || '', size: +f.size || 0, tagged: !/^(mp3|aac|flac)$/.test(extOf(f.name)) };
      finishTags(t, {});
      next.set(f.id, t);
    }
    lib = next; sorted = null; saveLib(); render();
    const todo = [...lib.values()].filter(t => !t.tagged);
    let dirty = 0, timer = null;
    const flush = () => { timer = null; sorted = null; saveLib(); render(); };
    await pool(todo, 4, async t => {
      const r = await api(`/files/${encodeURIComponent(t.id)}?alt=media&supportsAllDrives=true`, { headers: { Range: 'bytes=0-65535' } });
      if (r.ok) readTags(t, await r.arrayBuffer().catch(() => { throw new NetError(); }));
      t.tagged = true;
      if (++dirty % 25 === 0) flush(); else if (!timer) timer = setTimeout(flush, 700);
    });
    clearTimeout(timer); flush();
  } catch (e) {
    if (e instanceof AuthError) renderBanner();
    else toast(e.message);
  } finally {
    syncing = false; renderHead();
    if (syncAgain) { syncAgain = false; sync(); }
  }
}

// Runs fn over items, n at a time. Stops at the first network or sign-in error; other errors skip the item.
async function pool(items, n, fn) {
  let i = 0, stop = null;
  const worker = async () => {
    while (!stop && i < items.length) {
      const it = items[i++];
      try { await fn(it); }
      catch (e) { if (e instanceof NetError || e instanceof AuthError) stop = e; else it.tagged = true; }
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
  if (stop) throw stop;
}

// Downloads one song into memory. onProg(fraction) reports progress.
async function fetchSong(t, signal, onProg) {
  const r = await api(`/files/${encodeURIComponent(t.id)}?alt=media&supportsAllDrives=true`, { signal });
  if (r.status === 404) throw new GoneError();
  if (!r.ok) throw new Error(`Google Drive didn't send this song (error ${r.status})`);
  const type = TYPES[extOf(t.name)] || 'audio/mpeg';
  const total = +r.headers.get('content-length') || t.size || 0;
  try {
    if (!r.body || !r.body.getReader) return new Blob([await r.arrayBuffer()], { type });
    const reader = r.body.getReader(), parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      if (onProg && total) onProg(got / total);
    }
    return new Blob(parts, { type });
  } catch (e) {
    if (isAbort(e) || (signal && signal.aborted)) { const a = new Error('aborted'); a.name = 'AbortError'; throw a; }
    throw new NetError();
  }
}

// ── player ──
const audio = $('#audio');
let q = { base: [], order: [], i: -1, ctx: 'Library' };
let cur = null;          // id of the current song
let curUrl = null;       // blob URL playing now
let loaded = false;      // the current song is in the audio element
let loading = null;      // { id, ctl }
let loadPct = 0;
let pendingSeek = 0;     // position to start from when the song is loaded
let nxt = null;          // prefetched next song: { id, ctl, p }
let skips = 0;
let seeking = false;

{
  const st = S.get('play', null);
  if (st && st.cur && lib.has(st.cur)) {
    q = Object.assign(q, st.q || {}); cur = st.cur; pendingSeek = st.pos || 0;
    if (q.order.indexOf(cur) < 0) { q.order = [cur]; q.base = [cur]; q.i = 0; }
    else q.i = q.order.indexOf(cur);
  }
}

function saveState() {
  if (!cur) { S.del('play'); return; }
  S.set('play', { cur, pos: loaded ? audio.currentTime : pendingSeek, q });
}

// iOS only lets a page start sound after a tap. A song arrives seconds after the tap, so the
// audio element is unlocked on the first tap by playing a moment of silence.
let unlocked = false;
const SILENT = (() => {
  const n = 800, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
})();
function unlock() {
  if (unlocked || loaded || loading) return;
  unlocked = true;
  audio.src = SILENT;
  const p = audio.play();
  if (p) p.then(() => { if (audio.src === SILENT) audio.pause(); }).catch(e => { if (e.name === 'NotAllowedError') unlocked = false; });
}
document.addEventListener('touchend', unlock, true);
document.addEventListener('click', unlock, true);

const isCur = () => loaded && audio.src === curUrl;

function shuffled(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function playFrom(tracks, idx, ctx) {
  const ids = tracks.map(t => t.id);
  q.base = ids; q.ctx = ctx;
  if (prefs.shuffle) { q.order = [ids[idx]].concat(shuffled(ids.filter((_, j) => j !== idx))); q.i = 0; }
  else { q.order = ids.slice(); q.i = idx; }
  skips = 0;
  start(0, true);
}

async function start(at, autoplay) {
  const id = q.order[q.i];
  const t = id && lib.get(id);
  if (!t) return;
  if (loading) { loading.ctl.abort(); loading = null; }
  cur = id; pendingSeek = at; loaded = false; loadPct = 0;
  audio.pause();
  saveState(); updateMeta(t); render();
  if (!autoplay) return;
  const my = loading = { id, ctl: new AbortController() };
  renderPlayer();
  let url = null;
  try {
    if (nxt && nxt.id === id) {
      const n = nxt; nxt = null; my.ctl = n.ctl;
      try { url = await n.p; } catch (e) { if (isAbort(e)) throw e; my.ctl = new AbortController(); }
    } else dropNext();
    if (!url) url = URL.createObjectURL(await fetchSong(t, my.ctl.signal, f => { if (loading === my) { loadPct = f; renderLoad(); } }));
  } catch (e) {
    if (loading !== my) return;
    loading = null;
    if (isAbort(e)) return;
    songFailed(t, e);
    return;
  }
  if (loading !== my) { URL.revokeObjectURL(url); return; }
  loading = null;
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = url; audio.src = url; loaded = true;
  const seekTo = pendingSeek; pendingSeek = 0;
  if (seekTo > 0) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = seekTo; } catch {} }, { once: true });
  try { await audio.play(); skips = 0; }
  catch (e) { if (e.name === 'NotAllowedError') toast('Tap play to start'); }
  render();
}

function songFailed(t, e) {
  if (e instanceof GoneError && ++skips < 5) { toast(`“${t.title}” isn't on Google Drive anymore — skipped`); next(true); return; }
  if (e instanceof AuthError) renderBanner();
  toast(e.message);
  render();
}

function nextIndex(auto) {
  if (!q.order.length) return -1;
  if (q.i + 1 < q.order.length) return q.i + 1;
  if (prefs.repeat === 1 || !auto) return 0;
  return -1;
}

function next(auto) {
  const i = nextIndex(auto);
  if (i < 0) { audio.pause(); render(); return; }
  q.i = i; start(0, true);
}

function prev() {
  if (isCur() && audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (q.i > 0) q.i--;
  else if (prefs.repeat === 1) q.i = q.order.length - 1;
  else { if (isCur()) audio.currentTime = 0; return; }
  start(0, true);
}

function togglePlay() {
  if (!cur) { if (shown.length) playFrom(shown, 0, ctxName()); return; }
  if (loading) return;
  if (!loaded) { start(pendingSeek, true); return; }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}

// Fetch the next song a little after this one starts, so a locked phone can change songs without waiting.
function prefetchNext() {
  if (prefs.repeat === 2) { dropNext(); return; }
  const i = nextIndex(true), id = i >= 0 ? q.order[i] : null;
  if (nxt && nxt.id === id) return;
  dropNext();
  const t = id && id !== cur && lib.get(id);
  if (!t || t.size > 80e6) return;
  const ctl = new AbortController();
  const p = fetchSong(t, ctl.signal).then(b => URL.createObjectURL(b));
  p.catch(() => {});
  nxt = { id, ctl, p };
}
function dropNext() {
  if (!nxt) return;
  nxt.ctl.abort(); nxt.p.then(u => URL.revokeObjectURL(u), () => {}); nxt = null;
}

function playNext(id) {
  if (!cur) { const t = lib.get(id); if (t) playFrom([t], 0, ctxName()); return; }
  const at = q.order.indexOf(id);
  if (at >= 0 && at !== q.i) { q.order.splice(at, 1); if (at < q.i) q.i--; }
  if (id !== cur) q.order.splice(q.i + 1, 0, id);
  saveState(); toast('Plays next');
  if (isCur() && !audio.paused) prefetchNext();
}

function setShuffle(on) {
  prefs.shuffle = on; savePrefs();
  if (cur) {
    if (on) { q.order = [cur].concat(shuffled(q.base.filter(id => id !== cur))); q.i = 0; }
    else { q.order = q.base.slice(); q.i = Math.max(0, q.order.indexOf(cur)); if (q.order.indexOf(cur) < 0) { q.order.unshift(cur); } }
    saveState();
    if (isCur() && !audio.paused) prefetchNext();
  }
  renderPlayer();
}

function cycleRepeat() {
  prefs.repeat = (prefs.repeat + 1) % 3; savePrefs();
  toast(['Repeat off', 'Repeat all', 'Repeat this song'][prefs.repeat]);
  if (isCur() && !audio.paused) prefetchNext();
  renderPlayer();
}

let lastSave = 0, lastPos = 0;
audio.addEventListener('timeupdate', () => {
  if (!isCur()) return;
  if (!seeking) renderTime();
  const now = Date.now();
  if (now - lastSave > 5000) { lastSave = now; saveState(); }
  if (now - lastPos > 4000) { lastPos = now; positionState(); }
  if (!nxt && audio.currentTime > 8) prefetchNext();
});
audio.addEventListener('loadedmetadata', () => { if (isCur()) { renderTime(); positionState(); } });
for (const ev of ['play', 'pause', 'playing']) audio.addEventListener(ev, () => {
  if (!isCur()) return;
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  if (ev === 'pause') saveState();
  renderPlayer(); renderList();
});
audio.addEventListener('ended', () => {
  if (!isCur()) return;
  if (prefs.repeat === 2) { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  next(true);
});
audio.addEventListener('error', () => {
  if (!isCur()) return;
  const t = lib.get(cur);
  loaded = false;
  toast(`Can't play “${t ? t.title : 'this song'}” on this phone`);
  if (++skips < 5) next(true); else render();
});

// Lock screen and Control Center.
function updateMeta(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist || '', album: t.album || '',
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  } catch {}
}
function positionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const d = audio.duration;
  if (!isFinite(d) || d <= 0) return;
  try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(audio.currentTime, d), playbackRate: 1 }); } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession, on = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  on('play', () => { if (loaded) audio.play().catch(() => {}); else togglePlay(); });
  on('pause', () => audio.pause());
  on('previoustrack', prev);
  on('nexttrack', () => next(false));
  on('seekto', d => { if (isCur() && d.seekTime != null) { audio.currentTime = d.seekTime; positionState(); } });
}

// ── likes and playlists ──
const isLiked = id => liked.indexOf(id) >= 0;
function toggleLike(id) {
  const i = liked.indexOf(id);
  if (i >= 0) liked.splice(i, 1); else liked.unshift(id);
  saveLiked(); render();
  toast(i >= 0 ? 'Removed from Liked Songs' : 'Added to Liked Songs');
}
async function newPlaylist(firstId) {
  const name = await ask('New playlist', '', { placeholder: 'Playlist name', ok: 'Create' });
  if (!name || !name.trim()) return null;
  const pl = { id: uid(), name: name.trim(), ids: firstId ? [firstId] : [] };
  playlists.push(pl); savePlaylists(); render();
  if (firstId) toast(`Added to ${pl.name}`);
  return pl;
}
function addToPlaylist(pl, id) {
  if (pl.ids.indexOf(id) >= 0) { toast(`Already in ${pl.name}`); return; }
  pl.ids.push(id); savePlaylists(); render(); toast(`Added to ${pl.name}`);
}
const plOf = v => v && v.startsWith('pl:') ? playlists.find(p => p.id === v.slice(3)) : null;

// ── rendering ──
function ctxName() {
  if (view === 'liked') return 'Liked Songs';
  const pl = plOf(view);
  return pl ? pl.name : 'Library';
}

function viewTracks() {
  let a;
  if (view === 'liked') a = liked.map(id => lib.get(id)).filter(Boolean);
  else if (plOf(view)) a = plOf(view).ids.map(id => lib.get(id)).filter(Boolean);
  else {
    if (!sorted) sorted = [...lib.values()].sort((x, y) => coll.compare(x.title, y.title) || coll.compare(x.artist || '', y.artist || ''));
    a = sorted;
  }
  if (query) {
    const words = norm(query).split(/\s+/).filter(Boolean);
    a = a.filter(t => { const k = norm(t.title + ' ' + (t.artist || '') + ' ' + (t.album || '')); return words.every(w => k.indexOf(w) >= 0); });
  }
  return a;
}

function render() { renderHead(); renderList(); renderPlayer(); }

function renderHead() {
  const pl = plOf(view);
  if (view.startsWith('pl:') && !pl) { view = 'playlists'; }
  $('#title').textContent = pl ? pl.name : view === 'liked' ? 'Liked Songs' : view === 'playlists' ? 'Playlists' : 'Library';
  $('#back').hidden = !pl;
  $('#searchBox').hidden = view === 'playlists';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view || (b.dataset.view === 'playlists' && !!pl)));
  let s = '';
  if (view === 'playlists') s = playlists.length + (playlists.length === 1 ? ' playlist' : ' playlists');
  else {
    const n = pl ? pl.ids.filter(id => lib.has(id)).length : view === 'liked' ? liked.filter(id => lib.has(id)).length : lib.size;
    s = n + (n === 1 ? ' song' : ' songs');
    if (view === 'library' && drive && drive.folderName) s += ' · ' + drive.folderName;
  }
  if (syncing) s += ' · syncing Google Drive…';
  $('#sub').textContent = s;
  renderBanner();
}

function renderBanner() { $('#banner').hidden = !!(drive && drive.refresh) || $('#app').hidden; }

function empty(title, text) { return `<div class="empty"><b>${esc(title)}</b>${esc(text)}</div>`; }

function renderList() {
  const box = $('#list');
  if (view === 'playlists') {
    shown = [];
    let h = `<div class="row" data-new="1"><div class="art icon-art">${I.plus}</div><div class="meta"><div class="t">New playlist</div></div></div>`;
    const songs = n => n + (n === 1 ? ' song' : ' songs');
    h += `<div class="row" data-open="liked"><div class="art liked-art">${I.heartFill}</div><div class="meta"><div class="t">Liked Songs</div><div class="s">${songs(liked.filter(id => lib.has(id)).length)}</div></div></div>`;
    for (const p of playlists) {
      h += `<div class="row" data-open="pl:${esc(p.id)}"><div class="art icon-art">${I.list}</div><div class="meta"><div class="t">${esc(p.name)}</div><div class="s">${songs(p.ids.filter(id => lib.has(id)).length)}</div></div><button class="more" data-plmore="${esc(p.id)}" aria-label="More">${I.more}</button></div>`;
    }
    box.innerHTML = h;
    return;
  }
  shown = viewTracks();
  if (!shown.length) {
    if (query) box.innerHTML = empty('No matches', `No songs match “${query}”.`);
    else if (view === 'liked') box.innerHTML = empty('No liked songs yet', 'Tap ♥ on a song and it shows up here.');
    else if (plOf(view)) box.innerHTML = empty('This playlist is empty', 'Add songs with ⋯ → Add to playlist.');
    else if (syncing) box.innerHTML = empty('Loading your music…', 'Getting the song list from Google Drive.');
    else if (!drive || !drive.refresh) box.innerHTML = empty('Signed out', 'Sign in to Google Drive to see your music.');
    else box.innerHTML = empty('No songs found', drive.folderId ? 'This Drive folder has no mp3, m4a, mp4, aac, flac or wav files.' : 'No music files in your Google Drive yet.');
    return;
  }
  const playing = cur && isCur() && !audio.paused;
  let h = '';
  for (let i = 0; i < shown.length; i++) {
    const t = shown[i], c = t.id === cur;
    h += `<div class="row${c ? ' cur' : ''}" data-i="${i}"><div class="art" style="--h:${hue(t.album || t.artist || t.title)}">${esc(letter(t.title))}</div>` +
      `<div class="meta"><div class="t">${c && playing ? '▶ ' : ''}${esc(t.title)}</div><div class="s">${isLiked(t.id) ? '<span class="h">♥</span> ' : ''}${esc(sub(t))}</div></div>` +
      `<button class="more" data-more="${i}" aria-label="More">${I.more}</button></div>`;
  }
  box.innerHTML = h;
}

function setArt(el, t) {
  el.style.setProperty('--h', hue(t.album || t.artist || t.title));
  el.textContent = letter(t.title);
}

function renderPlayer() {
  const t = cur && lib.get(cur);
  $('#mini').hidden = !t;
  if (!t) { closeFull(); return; }
  const playing = isCur() && !audio.paused, busy = !!loading;
  const btn = busy ? '<div class="spin"></div>' : playing ? I.pause : I.play;
  setArt($('#mArt'), t); setArt($('#fArt'), t);
  $('#full').style.setProperty('--h', hue(t.album || t.artist || t.title));
  $('#mTitle').textContent = t.title; $('#fTitle').textContent = t.title;
  $('#fArtist').textContent = t.artist || 'Unknown artist';
  $('#fCtx').textContent = q.ctx || 'Library';
  $('#mPlay').innerHTML = btn; $('#fPlay').innerHTML = btn;
  $('#mPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const lk = isLiked(t.id);
  for (const b of [$('#mLike'), $('#fLike')]) { b.innerHTML = lk ? I.heartFill : I.heart; b.classList.toggle('on', lk); }
  $('#fShuf').innerHTML = I.shuffle; $('#fShuf').classList.toggle('on', prefs.shuffle);
  $('#fRep').innerHTML = prefs.repeat === 2 ? I.repeat1 : I.repeat; $('#fRep').classList.toggle('on', prefs.repeat > 0);
  $('#seek').disabled = !isCur();
  renderLoad(); renderTime();
}

function renderLoad() {
  const t = cur && lib.get(cur);
  if (!t) return;
  $('#mSub').textContent = loading ? `Loading from Google Drive… ${Math.round(loadPct * 100)}%` : (t.artist || 'Unknown artist');
}

function renderTime() {
  const d = isCur() ? audio.duration : NaN, c = isCur() ? audio.currentTime : pendingSeek;
  const f = isFinite(d) && d > 0 ? Math.min(1, c / d) : 0;
  $('#mBar').style.width = (f * 100) + '%';
  if (!seeking) { $('#seek').value = Math.round(f * 1000); $('#seek').style.setProperty('--p', (f * 100) + '%'); }
  $('#tCur').textContent = fmt(c);
  $('#tDur').textContent = isFinite(d) && d > 0 ? fmt(d) : loading ? Math.round(loadPct * 100) + '%' : '';
}

// ── sheets, dialogs, toast ──
let toastTimer = null;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function sheet(title, items) {
  const el = $('#sheet');
  el.querySelector('.sheet-title').textContent = title || '';
  const box = el.querySelector('.items');
  box.innerHTML = '';
  for (const it of items) {
    if (it.info) { const d = document.createElement('div'); d.className = 'info'; d.textContent = it.info; box.appendChild(d); continue; }
    const b = document.createElement('button');
    b.textContent = it.label; if (it.danger) b.className = 'danger';
    b.onclick = () => { el.hidden = true; it.fn(); };
    box.appendChild(b);
  }
  el.hidden = false;
}
$('#sheet .backdrop').onclick = $('#sheet .cancel').onclick = () => { $('#sheet').hidden = true; };

function dialog(title, text, input, okLabel, danger) {
  return new Promise(res => {
    const m = $('#modal'), f = m.querySelector('form'), inp = m.querySelector('.minput'), ok = m.querySelector('.mok');
    m.querySelector('.mtitle').textContent = title;
    m.querySelector('.mtext').textContent = text || '';
    inp.hidden = input == null; inp.value = input ? input.value || '' : ''; inp.placeholder = input ? input.placeholder || '' : '';
    ok.textContent = okLabel || 'OK'; ok.classList.toggle('danger', !!danger);
    const done = v => { m.hidden = true; f.onsubmit = null; res(v); };
    f.onsubmit = e => { e.preventDefault(); done(input == null ? true : inp.value); };
    m.querySelector('.mcancel').onclick = m.querySelector('.backdrop').onclick = () => done(input == null ? false : null);
    m.hidden = false;
    if (input != null) setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
const ask = (title, value, o = {}) => dialog(title, o.text, { value, placeholder: o.placeholder }, o.ok);
const confirmBox = (title, text, ok, danger) => dialog(title, text, null, ok, danger);

// ── menus ──
function songMenu(t) {
  const pl = plOf(view), items = [];
  if (cur && t.id !== cur) items.push({ label: 'Play next', fn: () => playNext(t.id) });
  items.push({ label: isLiked(t.id) ? 'Remove from Liked Songs' : 'Add to Liked Songs', fn: () => toggleLike(t.id) });
  items.push({ label: 'Add to playlist…', fn: () => pickPlaylist(t.id) });
  if (pl) items.push({ label: 'Remove from this playlist', danger: true, fn: () => { pl.ids = pl.ids.filter(id => id !== t.id); savePlaylists(); render(); } });
  items.push({ label: 'Open in Google Drive', fn: () => window.open(`https://drive.google.com/file/d/${encodeURIComponent(t.id)}/view`, '_blank') });
  sheet(t.title + (t.artist ? ' · ' + t.artist : ''), items);
}

function pickPlaylist(id) {
  const items = [{ label: 'New playlist…', fn: () => newPlaylist(id) }];
  for (const p of playlists) items.push({ label: p.name, fn: () => addToPlaylist(p, id) });
  sheet('Add to playlist', items);
}

function playlistMenu(pl) {
  sheet(pl.name, [
    { label: 'Rename…', fn: async () => { const n = await ask('Rename playlist', pl.name, { ok: 'Save' }); if (n && n.trim()) { pl.name = n.trim(); savePlaylists(); render(); } } },
    { label: 'Delete playlist', danger: true, fn: async () => {
      if (!(await confirmBox(`Delete “${pl.name}”?`, 'The songs stay in your library and on Google Drive.', 'Delete', true))) return;
      playlists = playlists.filter(p => p !== pl); savePlaylists();
      if (view === 'pl:' + pl.id) setView('playlists'); else render();
    } },
  ]);
}

function driveMenu() {
  const where = drive && drive.folderId ? `Folder: ${drive.folderName || 'Google Drive folder'}` : 'All music in your Google Drive';
  const items = [{ info: where }];
  if (drive && drive.refresh) {
    items.push({ label: 'Sync now', fn: sync });
    items.push({ label: 'Change folder…', fn: changeFolder });
  } else items.push({ label: 'Sign in to Google Drive', fn: () => showSetup('', false, drive) });
  items.push({ label: 'Disconnect Google Drive', danger: true, fn: disconnect });
  sheet('Google Drive', items);
}

async function changeFolder() {
  const v = await ask('Music folder', drive.folderId ? `https://drive.google.com/drive/folders/${drive.folderId}` : '',
    { text: 'Paste a Google Drive folder link. Leave it empty to use all music in your Drive.', placeholder: 'https://drive.google.com/drive/folders/…', ok: 'Use folder' });
  if (v == null) return;
  const id = parseFolderId(v);
  if (id == null) { toast("That doesn't look like a Google Drive folder link"); return; }
  if (id === (drive.folderId || '')) return;
  let name = '';
  if (id) { try { name = await folderName(id); } catch (e) { toast(e.message); return; } }
  drive.folderId = id; drive.folderName = name; saveDrive();
  sync();
}

async function disconnect() {
  if (!(await confirmBox('Disconnect Google Drive?', 'Your Google Drive isn’t changed. The song list on this iPhone is cleared; likes and playlists are kept for when you sign in again.', 'Disconnect', true))) return;
  const tok = drive && drive.refresh;
  if (tok) fetch(EP.revoke, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok }) }).catch(() => {});
  if (loading) { loading.ctl.abort(); loading = null; }
  dropNext(); audio.pause(); audio.removeAttribute('src'); loaded = false;
  if (curUrl) { URL.revokeObjectURL(curUrl); curUrl = null; }
  cur = null; q = { base: [], order: [], i: -1, ctx: 'Library' }; S.del('play');
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  const keep = drive ? { clientId: drive.clientId, secret: drive.secret, folderId: drive.folderId } : null;
  drive = null; access = null; S.del('drive'); S.del('access');
  lib = new Map(); sorted = null; saveLib();
  showSetup('Disconnected. Your Google Drive was not changed.', false, keep);
}

// ── setup screen ──
function showSetup(msg, isErr, fill) {
  $('#app').hidden = true; $('#setup').hidden = false; closeFull();
  if (fill) {
    $('#cid').value = fill.clientId || ''; $('#csec').value = fill.secret || '';
    $('#cfolder').value = fill.folderId ? `https://drive.google.com/drive/folders/${fill.folderId}` : '';
  }
  $('#ruri').textContent = REDIRECT;
  setupMsg(msg || '', isErr);
  $('#setupCancel').hidden = !(drive && lib.size);
  $('#signin').disabled = false;
}
function setupMsg(m, err) { const el = $('#setupMsg'); el.textContent = m; el.classList.toggle('err', !!err); }
function showApp() { $('#setup').hidden = true; $('#app').hidden = false; render(); }

$('#setupForm').onsubmit = e => {
  e.preventDefault();
  const id = $('#cid').value.trim(), sec = $('#csec').value.trim(), folder = parseFolderId($('#cfolder').value);
  if (!/\.apps\.googleusercontent\.com$/.test(id)) return setupMsg('The Client ID ends with .apps.googleusercontent.com — copy it from Google Cloud.', true);
  if (!sec) return setupMsg('Paste the Client secret too.', true);
  if (folder == null) return setupMsg("The folder link doesn't look right. Copy it from drive.google.com, or leave it empty.", true);
  $('#signin').disabled = true;
  setupMsg('Opening Google…');
  signIn(id, sec, folder).catch(err => { $('#signin').disabled = false; setupMsg(err.message, true); });
};
$('#setupCancel').onclick = showApp;
$('#copyUri').onclick = async () => {
  try { await navigator.clipboard.writeText(REDIRECT); $('#copyUri').textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents($('#ruri')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $('#copyUri').textContent = 'Selected'; }
  setTimeout(() => { $('#copyUri').textContent = 'Copy'; }, 1800);
};
$('#cjson').onchange = async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (j.installed) return setupMsg('This file is for a "Desktop app" client. Hum on iPhone needs a "Web application" client — see the guide.', true);
    const w = j.web;
    if (!w || !w.client_id) return setupMsg("This isn't a Google OAuth client file.", true);
    $('#cid').value = w.client_id; $('#csec').value = w.client_secret || '';
    const bad = w.redirect_uris && w.redirect_uris.indexOf(REDIRECT) < 0;
    setupMsg(bad ? 'Filled in. But this client doesn\'t list the redirect URI below yet — add it in Google Cloud first.' : 'Filled in from the file.', bad);
  } catch { setupMsg("Couldn't read that file.", true); }
};

// ── full player sheet ──
function openFull() { if (!cur) return; $('#full').classList.add('open'); $('#full').setAttribute('aria-hidden', 'false'); renderPlayer(); }
function closeFull() { $('#full').classList.remove('open'); $('#full').setAttribute('aria-hidden', 'true'); }
{
  const full = $('#full');
  let y0 = null, dy = 0;
  full.addEventListener('touchstart', e => { if (e.target.closest('#seek, .controls')) return; y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  full.addEventListener('touchmove', e => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); if (dy > 6) { full.classList.add('drag'); full.style.transform = `translateY(${dy}px)`; } }, { passive: true });
  full.addEventListener('touchend', () => { if (y0 == null) return; full.classList.remove('drag'); full.style.transform = ''; if (dy > 110) closeFull(); y0 = null; });
}

// ── wiring ──
function setView(v) { view = v; query = ''; $('#q').value = ''; S.set('view', v); $('#scroll').scrollTop = 0; render(); }

$('#tabs').onclick = e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); };
$('#back').onclick = () => setView('playlists');
$('#menu').onclick = () => { const pl = plOf(view); pl ? playlistMenu(pl) : driveMenu(); };
$('#resign').onclick = () => showSetup('', false, drive);
$('#q').oninput = e => { query = e.target.value; renderList(); };
$('#list').onclick = e => {
  const m = e.target.closest('[data-more]');
  if (m) { songMenu(shown[+m.dataset.more]); return; }
  const pm = e.target.closest('[data-plmore]');
  if (pm) { const pl = playlists.find(p => p.id === pm.dataset.plmore); if (pl) playlistMenu(pl); return; }
  const row = e.target.closest('.row');
  if (!row) return;
  if (row.dataset.new) { newPlaylist(); return; }
  if (row.dataset.open) { setView(row.dataset.open); return; }
  const i = +row.dataset.i, t = shown[i];
  if (!t) return;
  if (t.id === cur && (loaded || loading)) { if (loaded && audio.paused) audio.play().catch(() => {}); openFull(); return; }
  playFrom(shown, i, ctxName());
};
$('#mini').onclick = e => {
  if (e.target.closest('#mPlay')) { togglePlay(); return; }
  if (e.target.closest('#mLike')) { toggleLike(cur); return; }
  openFull();
};
$('#fClose').onclick = closeFull;
$('#fMore').onclick = () => { const t = lib.get(cur); if (t) songMenu(t); };
$('#fPlay').onclick = togglePlay;
$('#fNext').onclick = () => next(false);
$('#fPrev').onclick = prev;
$('#fLike').onclick = () => cur && toggleLike(cur);
$('#fShuf').onclick = () => setShuffle(!prefs.shuffle);
$('#fRep').onclick = cycleRepeat;
{
  const sk = $('#seek');
  const show = () => { const d = audio.duration; sk.style.setProperty('--p', (sk.value / 10) + '%'); if (isFinite(d)) $('#tCur').textContent = fmt(sk.value / 1000 * d); };
  sk.addEventListener('input', () => { seeking = true; show(); });
  sk.addEventListener('change', () => {
    seeking = false;
    const d = audio.duration;
    if (isCur() && isFinite(d)) { audio.currentTime = sk.value / 1000 * d; positionState(); saveState(); }
    renderTime();
  });
}
document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = I[el.dataset.icon]; });
$('#back').innerHTML = I.back; $('#menu').innerHTML = I.more; $('#fClose').innerHTML = I.down; $('#fMore').innerHTML = I.more;
$('#fPrev').innerHTML = I.prev; $('#fNext').innerHTML = I.next;
$('#searchBox .sicon').innerHTML = I.search;

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveState();
  else if (Date.now() - lastSync > 30 * 60000) sync();
});
addEventListener('pagehide', saveState);

// ── start ──
(async () => {
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const p = new URLSearchParams(location.search);
  if (p.has('code') || p.has('error')) {
    if (!(await finishSignIn(p))) return;
    showApp(); sync(); return;
  }
  if (p.has('api')) history.replaceState(null, '', REDIRECT);
  if ((drive && drive.refresh) || lib.size) {
    showApp();
    if (cur) updateMeta(lib.get(cur));
    if (drive && drive.refresh) sync();
  } else showSetup('', false, drive);
})();
