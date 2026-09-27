/**
 * Denji-T · Google Drive réteg
 */

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const LIB_CACHE_KEY = 'denjit_library_v1';
const MAGNET_RE = /magnet:\?xt=urn:[^\s"']+/i;

/* ---------------- Backend (server.py) ----------------
 * A reklámmentes lejátszáshoz és a szövegfájlok olvasásához kell egy futó szerver.
 * Statikus tárhelyen (pl. GitHub Pages) ilyen nincs — ott CONFIG.API_BASE adja meg,
 * hol fut. Üres API_BASE mellett csak localhoston próbálkozunk. */
const apiUrl = (path) => `${(CONFIG.API_BASE || '').replace(/\/+$/, '')}${path}`;
const hasBackend = () => !!CONFIG.API_BASE ||
    location.hostname === 'localhost' || location.hostname === '127.0.0.1';

/**
 * Korlátozott párhuzamosságú map — a Drive listázás így sokszor gyorsabb,
 * de nem terheli túl az API-t. A sorrend megmarad.
 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            try {
                results[index] = await worker(items[index], index);
            } catch (e) {
                results[index] = null;
            }
        }
    });
    await Promise.all(runners);
    return results;
}

/* Lekérés időkorláttal — a lassú Drive válaszok nem blokkolják az oldalt */
async function fetchWithTimeout(url, ms, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

const authHeaders = (token, contentType) => contentType
    ? { 'Authorization': `Bearer ${token}`, 'Content-Type': contentType }
    : { 'Authorization': `Bearer ${token}` };

/* A beágyazható Streamtape forma /e/, a megosztott link /v/ — a tükördomainek
   (streamtape.to, strtape.cloud…) is streamtape.com-ra kerülnek (media-parse.js) */
const toEmbedUrl = (url) => normalizeStreamUrl(url);

/* A torrent kliensek a &dn= paraméterből veszik a letöltés nevét */
const withDisplayName = (uri, title) =>
    (title && !uri.toLowerCase().includes('&dn=')) ? `${uri}&dn=${encodeURIComponent(title)}` : uri;

/* Csak akkor ad vissza linket, ha a szövegben valódi magnet URI van */
function findMagnet(text, title) {
    const match = String(text || '').match(MAGNET_RE);
    return match ? withDisplayName(match[0], title) : '';
}

/* Nemnegatív egész szám, különben a tartalék (a 0. rész is érvényes) */
const toCount = (value, fallback) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/* Évad/rész listák egységesítése — ugyanaz a forma olvasáskor és mentéskor.
   A számok mindig számok (nem „01” szöveg), az azonos számú évadok összeolvadnak,
   és minden számsorrendbe kerül. */
function cleanSeasons(seasons) {
    const bySeason = new Map();
    (seasons || []).forEach((s, si) => {
        const episodes = cleanEpisodes(s?.episodes);
        if (!episodes.length) return;
        const num = toCount(s?.season, si + 1);
        bySeason.set(num, [...(bySeason.get(num) || []), ...episodes]);
    });
    return [...bySeason.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([season, episodes]) => ({ season, episodes: episodes.sort((a, b) => a.ep - b.ep) }));
}

function cleanEpisodes(episodes) {
    return (episodes || []).map((e, i) => ({
        ep: toCount(e?.ep, i + 1),
        url: toEmbedUrl(e?.url)
    })).filter(e => e.url);
}

/* A sorozatadat kétféle alakban érkezhet: { seasons: [...] } vagy sima epizódtömb */
function applyEpisodeData(torrent, parsed) {
    if (Array.isArray(parsed?.seasons)) {
        torrent.seasons = cleanSeasons(parsed.seasons);
        return;
    }
    const eps = parsed?.episodes || (Array.isArray(parsed) ? parsed : null);
    if (eps?.length) torrent.episodes = cleanEpisodes(eps);
}

class DriveAPI {
    constructor() {
        this.cache = new Map();
    }

    /* ---------- Tartós gyorsítótár (azonnali első megjelenítés) ---------- */
    persistTorrents(torrents) {
        try {
            // A leírás rövidítve kerül a tárolóba; a jelzés alapján a szerkesztő a teljeset tölti be
            const slim = (torrents || []).map(t => {
                const cut = !!t.description && String(t.description).length > 600;
                return cut ? { ...t, description: String(t.description).slice(0, 600), descriptionCut: true } : t;
            });
            localStorage.setItem(LIB_CACHE_KEY, JSON.stringify({ ts: Date.now(), items: slim }));
        } catch (e) {
            // Kvóta túllépés esetén egyszerűen kihagyjuk
            console.warn('Library cache write skipped:', e.message);
        }
    }

    _readPersisted() {
        try {
            return JSON.parse(localStorage.getItem(LIB_CACHE_KEY)) || null;
        } catch (e) {
            return null;
        }
    }

    getPersistedTorrents() {
        const data = this._readPersisted();
        return Array.isArray(data?.items) ? data.items : null;
    }

    getPersistedAt() {
        return this._readPersisted()?.ts || 0;
    }

    // Memóriabeli gyorsítótár
    async getCached(key, fetchFn) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_TTL) {
            return cached.data;
        }
        const data = await fetchFn();
        this.cache.set(key, { data, timestamp: Date.now() });
        return data;
    }

    clearCache() {
        this.cache.clear();
    }

    /* ---------- Listázás ---------- */
    /* Tokennel (admin írásnál) a nem nyilvános fájlok is látszanak */
    async _listChildren(parentId, fields, extraQuery = '', token = null) {
        const q = `'${parentId}'+in+parents+and+trashed=false${extraQuery}`;
        const auth = token ? '' : `&key=${CONFIG.GOOGLE_API_KEY}`;
        const res = await fetch(`${DRIVE_FILES}?q=${q}${auth}&fields=files(${fields})&orderBy=name&pageSize=1000`,
            token ? { headers: authHeaders(token) } : {});
        if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
        return (await res.json()).files || [];
    }

    listFolders(parentId) {
        return this._listChildren(parentId, 'id,name,createdTime', `+and+mimeType='application/vnd.google-apps.folder'`);
    }

    listFiles(folderId, token = null) {
        return this._listChildren(folderId, 'id,name,mimeType,size,createdTime,webContentLink,description', '', token);
    }

    /**
     * Szövegfájl beolvasása (alt=media + API kulcs 403-at ad, ezért a kerülőutak).
     * skipDescription: a description mezőt már ismerjük (a listázásból), ne kérjük le újra —
     * vagy csonka volt (pl. nagyon hosszú episodes.json), és a teljes fájl kell.
     */
    async readTextFile(fileId, torrentTitle = '', { skipDescription = false } = {}) {
        if (!fileId) return '';

        const parseText = (text) => {
            if (!text) return '';
            if (text.includes('magnet:?')) {
                const match = text.match(MAGNET_RE);
                return withDisplayName(match ? match[0] : text.trim(), torrentTitle);
            }
            if (!text.includes('<!DOCTYPE html>') && !text.includes('<html>')) {
                return text.trim();
            }
            return '';
        };

        // 1. A Drive fájl description mezője API kulccsal (leggyorsabb, mindig elérhető)
        if (CONFIG.GOOGLE_API_KEY && !skipDescription) {
            try {
                const res = await fetchWithTimeout(`${DRIVE_FILES}/${fileId}?fields=description&key=${CONFIG.GOOGLE_API_KEY}`, 2500);
                if (res.ok) {
                    const { description } = await res.json();
                    const parsed = description?.trim() ? parseText(description.trim()) : '';
                    if (parsed) return parsed;
                }
            } catch (e) {}
        }

        // 2. Szerver proxy (/api/read_text) — csak ha van elérhető backend
        if (hasBackend()) {
            try {
                const titleParam = torrentTitle ? `&title=${encodeURIComponent(torrentTitle)}` : '';
                const nodesc = skipDescription ? '&nodesc=1' : '';
                const res = await fetchWithTimeout(apiUrl(`/api/read_text?id=${encodeURIComponent(fileId)}${titleParam}${nodesc}`), 4000);
                if (res.ok) {
                    const parsed = parseText(await res.text());
                    if (parsed) return parsed;
                }
            } catch (e) {}
        }

        // 3. OAuth hozzáférési token (csak adminnál van)
        if (this.accessToken) {
            try {
                const res = await fetchWithTimeout(`${DRIVE_FILES}/${fileId}?alt=media`, 1500, {
                    headers: authHeaders(this.accessToken)
                });
                if (res.ok) {
                    const parsed = parseText(await res.text());
                    if (parsed) return parsed;
                }
            } catch (e) {}
        }

        return '';
    }

    /**
     * Fájl bájtjai változatlanul (felirat). Sorban: API kulccsal közvetlenül, a szerveren át
     * (/api/read_text?raw=1), végül admin tokennel. HTML válasz (bejelentkező / figyelmeztető
     * oldal) nem számít sikernek.
     */
    async fetchFileBytes(fileId) {
        const id = encodeURIComponent(fileId);
        const attempts = [
            () => fetchWithTimeout(`${DRIVE_FILES}/${id}?alt=media&key=${CONFIG.GOOGLE_API_KEY}`, 8000),
            hasBackend() && (() => fetchWithTimeout(apiUrl(`/api/read_text?id=${id}&raw=1`), 10000)),
            this.accessToken && (() => fetchWithTimeout(`${DRIVE_FILES}/${id}?alt=media`, 8000, { headers: authHeaders(this.accessToken) })),
        ].filter(Boolean);

        let lastError = null;
        for (const attempt of attempts) {
            try {
                const res = await attempt();
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = await res.arrayBuffer();
                if (!buf.byteLength) throw new Error('üres válasz');
                const head = new TextDecoder().decode(buf.slice(0, 300)).toLowerCase();
                if (head.includes('<!doctype html') || head.includes('<html')) throw new Error('HTML válasz');
                return buf;
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError || new Error('A fájl nem érhető el');
    }

    // Borítókép URL (Google CDN — CORS és referer korlátozás nélkül minden böngészőben működik)
    getCoverImageUrl(fileId) {
        return `https://lh3.googleusercontent.com/d/${fileId}`;
    }

    // Egy tartalom-mappa feldolgozása: borító, magnet, torrent fájl, leírás, stream
    async processTorrentFolder(folder, defaultCategory = 'Játék') {
        let files = [];
        try {
            files = await this.listFiles(folder.id);
        } catch (e) {
            console.error('Failed to list files for folder:', folder.name, e);
            return null;
        }

        const torrent = {
            id: folder.id,
            title: folder.name,
            category: defaultCategory,
            createdTime: folder.createdTime,
            coverUrl: null,
            magnetLink: null,
            magnetFileId: null,
            torrentFileId: null,
            torrentFileName: null,
            description: null,
            streamUrl: null,
            downloadUrl: null,
            trailers: [],
            subtitles: [],  // [{ id, name }] — .srt/.vtt fájlok a mappában
            episodes: null, // régi, lapos forma: [{ ep: 1, url: '...' }]
            seasons: null,  // [{ season: 1, episodes: [{ ep: 1, url }] }]
            isMagyar: false,
        };

        /* A szövegfájlok tartalma mentéskor a description mezőbe is bekerül, és ezt a listázás
           már visszaadta — ilyenkor nincs mit még egyszer lekérni. A fájlt csak akkor olvassuk
           be, ha a description üres, vagy nem értelmezhető (pl. csonka JSON: az `apply` false-t ad). */
        const hydrate = (file, apply, title = '') => {
            const desc = file.description?.trim();
            if (desc && apply(desc) !== false) return;
            this.readTextFile(file.id, title, { skipDescription: true }).then(text => {
                if (text?.trim()) apply(text.trim());
            }).catch(() => {});
        };

        const applyEpisodesJson = (text) => {
            try {
                applyEpisodeData(torrent, JSON.parse(text));
                return true;
            } catch (e) {
                return false;
            }
        };

        const applyStreamText = (text) => {
            if (text.startsWith('{') || text.startsWith('[')) return applyEpisodesJson(text);
            // Több link (pl. kézzel feltöltött streamtape.txt): évadokra és részekre bontjuk
            const parsed = parseStreamLinks(text);
            if (parsed.linkCount > 1) torrent.seasons = cleanSeasons(parsed.seasons);
            else torrent.streamUrl = toEmbedUrl(parsed.linkCount ? parsed.seasons[0].episodes[0].url : text);
            return true;
        };

        for (const file of files) {
            const nameLower = file.name.toLowerCase();
            const mime = file.mimeType || '';

            // 1. Borítókép: kép mime típus vagy szokásos képkiterjesztés
            if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(file.name)) {
                torrent.coverUrl = this.getCoverImageUrl(file.id);
            }
            // 2. Torrent fájl
            else if (nameLower.endsWith('.torrent') || mime === 'application/x-bittorrent') {
                torrent.torrentFileId = file.id;
                torrent.torrentFileName = file.name;
            }
            // 2b. Felirat — a lejátszó a Drive-ról tölti be, amikor bekapcsolják
            else if (/\.(srt|vtt)$/i.test(nameLower)) {
                torrent.subtitles.push({ id: file.id, name: file.name });
            }
            // 3. Kategória (kategoria.txt)
            else if (nameLower === 'kategoria.txt' || nameLower === 'category.txt') {
                hydrate(file, (text) => { torrent.category = text; });
            }
            // 4. Stream (stream.txt) — filmnél egy URL, sorozatnál JSON
            else if (nameLower === 'stream.txt' || nameLower === 'streamtape.txt') {
                hydrate(file, applyStreamText);
            }
            // 4b. episodes.json — évadokkal vagy lapos epizódlistával
            else if (nameLower === 'episodes.json' || nameLower === 'episodes.txt') {
                hydrate(file, applyEpisodesJson);
            }
            // 5. Közvetlen letöltés (download.txt, letoltes.txt)
            else if (nameLower === 'download.txt' || nameLower === 'letoltes.txt') {
                hydrate(file, (text) => { torrent.downloadUrl = text; });
            }
            // 6. YouTube trailerek (trailers.txt, trailer.txt)
            else if (nameLower === 'trailers.txt' || nameLower === 'trailer.txt') {
                hydrate(file, (text) => {
                    torrent.trailers = text.split('\n').map(u => u.trim()).filter(Boolean);
                });
            }
            // 7. Leírás (leiras.txt, description.txt)
            else if (nameLower === 'leiras.txt' || nameLower === 'description.txt' || nameLower.startsWith('leiras')) {
                torrent.descriptionFileId = file.id;
                hydrate(file, (text) => {
                    torrent.description = text;
                    // Ha épp ez a tétel van nyitva, a leírás menet közben megjelenik
                    const descEl = document.querySelector('#detail-modal .detail-description');
                    if (descEl && window.app?.currentDetailId === torrent.id) descEl.textContent = text;
                }, folder.name);
            }
            // 8. Magyar jelölő (magyar.txt / is_magyar.txt) — a fájl megléte a jelzés.
            // A 9. pont általános .txt ága ELŐTT kell állnia!
            else if (nameLower === 'magyar.txt' || nameLower === 'is_magyar.txt') {
                torrent.isMagyar = true;
            }
            // 9. Egyéb szövegfájlok — jellemzően magnet linkek
            else if (nameLower.endsWith('.txt')) {
                if (nameLower.startsWith('magnet')) torrent.magnetFileId = file.id;
                const fromDescription = findMagnet(file.description, folder.name);
                if (fromDescription) {
                    torrent.magnetLink = fromDescription;
                } else {
                    this.readTextFile(file.id, folder.name, { skipDescription: true }).then(text => {
                        const magnet = findMagnet(text, folder.name);
                        if (magnet) torrent.magnetLink = magnet;
                    }).catch(() => {});
                }
            }
        }

        // A torrent objektum azonnal visszatér, a fenti olvasások a háttérben futnak tovább
        return torrent;
    }

    // Minden tartalom betöltése a kategória-mappákból és a gyökérből (párhuzamosan)
    async loadAllTorrents() {
        return this.getCached('all_torrents', async () => {
            const rootFolders = await this.listFolders(CONFIG.DRIVE_ROOT_FOLDER_ID);
            const isCategory = (f) => CONFIG.CATEGORIES.includes(f.name);

            // Kategória-mappák tartalmának listázása egyszerre
            const subLists = await Promise.all(rootFolders.filter(isCategory).map(async (f) => ({
                category: f.name,
                folders: await this.listFolders(f.id).catch(() => [])
            })));

            const jobs = [];
            subLists.forEach(({ category, folders }) =>
                folders.forEach(folder => jobs.push({ folder, category })));
            // Gyökérben álló mappák = külön torrentek
            rootFolders.filter(f => !isCategory(f)).forEach(folder => jobs.push({ folder, category: 'Játék' }));

            const processed = await mapLimit(jobs, 8, (job) =>
                this.processTorrentFolder(job.folder, job.category));

            const torrents = processed.filter(Boolean);
            this.persistTorrents(torrents);
            return torrents;
        });
    }

    /* ---------- OAuth ---------- */
    initOAuth() {
        const clientId = CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('denjit_client_id');
        if (!clientId) return false;

        if (typeof google === 'undefined' || !google.accounts?.oauth2) {
            console.warn('Google Identity Services library not loaded yet.');
            return false;
        }

        try {
            this.tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: clientId,
                scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive',
                callback: (response) => {
                    if (response.error) {
                        console.error('OAuth error:', response.error);
                        this._oauthReject?.(new Error(`OAuth hiba: ${response.error}`));
                        this._oauthReject = null;
                        return;
                    }
                    this.accessToken = response.access_token;
                    this._oauthResolve?.(this.accessToken);
                    this._oauthResolve = null;
                }
            });
            return true;
        } catch (e) {
            console.error('Failed to init OAuth:', e);
            return false;
        }
    }

    // Hozzáférési token kérése (Google bejelentkezést nyit)
    async getAccessToken() {
        if (this.accessToken) return this.accessToken;

        let clientId = CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('denjit_client_id');
        if (!clientId) {
            clientId = prompt('A Google Drive közvetlen feltöltéshez meg kell adnod a Google OAuth Client ID-t!\n\nHa nem állítottál be Client ID-t, a legegyszerűbb közvetlenül a Google Drive mappádban létrehozni az almappát.\n\nHa van Client ID-d, írd be ide:');
            if (!clientId?.trim()) {
                throw new Error('OAuth Client ID szükséges a weboldalon belüli feltöltéshez! (Használd a "Megnyitás Drive-ban" gombot a manuális feltöltéshez)');
            }
            clientId = clientId.trim();
            localStorage.setItem('denjit_client_id', clientId);
            CONFIG.GOOGLE_CLIENT_ID = clientId;
        }

        if (!this.tokenClient && !this.initOAuth()) {
            throw new Error('Nem sikerült az OAuth kliens inicializálása. Ellenőrizd a Client ID-t!');
        }

        return new Promise((resolve, reject) => {
            this._oauthResolve = resolve;
            this._oauthReject = reject;
            try {
                this.tokenClient.requestAccessToken();
            } catch (err) {
                reject(err);
            }
        });
    }

    /* ---------- Írás ---------- */
    async _patchFile(fileId, body) {
        const token = await this.getAccessToken();
        return fetch(`${DRIVE_FILES}/${fileId}`, {
            method: 'PATCH',
            headers: authHeaders(token, 'application/json'),
            body: JSON.stringify(body)
        });
    }

    async _deleteFile(fileId) {
        const token = await this.getAccessToken();
        return fetch(`${DRIVE_FILES}/${fileId}`, { method: 'DELETE', headers: authHeaders(token) });
    }

    /* Hibát dobó változatok: a mentés ne jelezzen sikert, ha egy lépése elhasalt */
    async _mustPatch(fileId, body, what) {
        const res = await this._patchFile(fileId, body);
        if (!res.ok) throw new Error(`${what} nem sikerült (HTTP ${res.status})`);
        return res;
    }

    async _mustDelete(fileId, what) {
        const res = await this._deleteFile(fileId);
        // A már nem létező fájl törlése nem hiba
        if (!res.ok && res.status !== 404) throw new Error(`${what} törlése nem sikerült (HTTP ${res.status})`);
    }

    async createFolder(name, parentId) {
        const token = await this.getAccessToken();
        const res = await fetch(DRIVE_FILES, {
            method: 'POST',
            headers: authHeaders(token, 'application/json'),
            body: JSON.stringify({
                name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId]
            })
        });
        if (!res.ok) throw new Error(`Failed to create folder: ${res.status}`);
        return res.json();
    }

    // Fájl feltöltése mappába (opcionális description metaadattal)
    async uploadFile(file, folderId, fileName, fileDescription = '') {
        const token = await this.getAccessToken();
        const metadata = { name: fileName || file.name, parents: [folderId] };
        if (fileDescription) {
            // A Drive description korlátja kb. 100 KB, maradjunk alatta
            metadata.description = String(fileDescription).slice(0, 90000);
        }

        const formData = new FormData();
        formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        formData.append('file', file);

        const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart`, {
            method: 'POST',
            headers: authHeaders(token),
            body: formData
        });
        if (!res.ok) {
            let detail = '';
            try { detail = await res.text(); } catch (e) {}
            console.error('Drive upload error:', res.status, detail);
            throw new Error(`Failed to upload file: ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
        }
        return res.json();
    }

    // Szövegfájl feltöltése — a description mezőbe is bekerül, így API kulccsal is olvasható
    uploadTextFile(content, folderId, fileName, fileDescription = '') {
        const file = new File([content], fileName, { type: 'text/plain' });
        return this.uploadFile(file, folderId, fileName, fileDescription);
    }

    /* Meglévő szövegfájl frissítése név alapján (ha nincs, létrehozza).
       `files`: a mappa már lekért fájllistája — megspórol egy listázást, és frissen tartjuk. */
    async upsertTextFile(folderId, fileName, content, files = null) {
        const token = await this.getAccessToken();
        const list = files || await this.listFiles(folderId, token);
        const existing = list.find(f => f.name.toLowerCase() === fileName.toLowerCase());
        if (!existing) {
            const created = await this.uploadTextFile(content, folderId, fileName, content);
            if (files) files.push({ ...created, name: fileName, description: content });
            return created;
        }

        await this._mustPatch(existing.id, { description: String(content).slice(0, 90000) }, fileName);
        const res = await fetch(`${DRIVE_UPLOAD}/${existing.id}?uploadType=media`, {
            method: 'PATCH',
            headers: authHeaders(token, 'text/plain'),
            body: content
        });
        if (!res.ok) throw new Error(`${fileName} mentése nem sikerült (HTTP ${res.status})`);
        existing.description = content;
        return existing;
    }

    /**
     * Feliratok: törlés, átnevezés, feltöltés — a tervet az űrlap állítja össze.
     * plan = { remove: [{ id, name }], rename: [{ id, name }], upload: [{ file, name }] }
     */
    async syncSubtitles(folderId, plan) {
        for (const sub of plan?.remove || []) await this._mustDelete(sub.id, sub.name);
        for (const sub of plan?.rename || []) await this._mustPatch(sub.id, { name: sub.name }, `${sub.name} átnevezése`);
        for (const sub of plan?.upload || []) await this.uploadFile(sub.file, folderId, sub.name);
    }

    /* Lejátszási adat az űrlapról: `requested` = érkezett sorozatadat (ilyenkor a film-stream
       kimarad), `cleaned` = a ténylegesen használható évadok. */
    _playbackData({ seasons, episodes }) {
        if (seasons?.length) {
            const cleaned = cleanSeasons(seasons);
            return { requested: true, cleaned, json: JSON.stringify({ seasons: cleaned }) };
        }
        if (episodes?.length) {
            const cleaned = cleanEpisodes(episodes);
            return { requested: true, cleaned, json: JSON.stringify({ seasons: [{ season: 1, episodes: cleaned }] }) };
        }
        return { requested: false, cleaned: [], json: null };
    }

    // Új tartalom: mappa a gyökérben + fájlok feltöltése
    async addTorrent({ title, category, coverFile, magnetLink, torrentFile, description, streamUrl, downloadUrl, trailers, seasons, episodes, isMagyar, subtitlePlan }) {
        const folder = await this.createFolder(title, CONFIG.DRIVE_ROOT_FOLDER_ID);
        const put = (content, name) => this.uploadTextFile(content, folder.id, name, content);

        if (category) await put(category, 'kategoria.txt');

        // Magyar kapcsoló: csak BE állapotban jön létre a magyar.txt.
        // A fájl megléte = isMagyar true. Ha nincs fájl = false.
        if (isMagyar === true) await put('true', 'magyar.txt');

        if (coverFile) {
            await this.uploadFile(coverFile, folder.id, `cover.${coverFile.name.split('.').pop()}`);
        }

        if (magnetLink) await put(magnetLink.trim(), 'magnet.txt');

        // Évadok VAGY régi lapos epizódlista VAGY egyetlen film-stream
        const playback = this._playbackData({ seasons, episodes });
        if (playback.cleaned.length) {
            await put(playback.json, 'episodes.json');
        } else if (!playback.requested && streamUrl) {
            await put(toEmbedUrl(streamUrl), 'stream.txt');
        }

        if (downloadUrl) await put(downloadUrl.trim(), 'download.txt');
        if (trailers?.length) await put(trailers.join('\n'), 'trailers.txt');
        if (torrentFile) await this.uploadFile(torrentFile, folder.id, torrentFile.name);
        if (description) await put(description, 'leiras.txt');
        if (subtitlePlan) await this.syncSubtitles(folder.id, subtitlePlan);

        this.clearCache();
        return folder;
    }

    /**
     * Meglévő tartalom szerkesztése.
     * `clear`: a mezők, amiket a felhasználó kiürített (volt értékük, most üresek) — ezek
     * fájljai törlődnek. Üres mező önmagában nem töröl: lehet, hogy az adat még be sem töltődött.
     * Kulcsok: magnet, download, trailers, description, stream, episodes.
     */
    async updateTorrent(folderId, { title, category, coverFile, magnetLink, torrentFile, description, streamUrl, downloadUrl, trailers, seasons, episodes, isMagyar, subtitlePlan, clear = [] }) {
        const token = await this.getAccessToken();
        const files = await this.listFiles(folderId, token);
        const matching = (test) => files.filter(f => test(f.name.toLowerCase()));
        const named = (...names) => matching(n => names.includes(n));
        const upsert = (name, content) => this.upsertTextFile(folderId, name, content, files);
        const remove = async (list) => {
            for (const f of list) {
                await this._mustDelete(f.id, f.name);
                files.splice(files.indexOf(f), 1);
            }
        };

        if (title) await this._mustPatch(folderId, { name: title }, 'Átnevezés');
        if (category) await upsert('kategoria.txt', category);

        // Szerkesztéskor: BE → magyar.txt létrehozása, KI → magyar.txt törlése
        if (isMagyar !== undefined && isMagyar !== null) {
            const existingMagyar = named('magyar.txt', 'is_magyar.txt');
            if (isMagyar === true) {
                if (!existingMagyar.length) await upsert('magyar.txt', 'true');
            } else {
                await remove(existingMagyar);
            }
        }

        if (coverFile) {
            await remove(files.filter(f => (f.mimeType || '').startsWith('image/') || /\.(jpe?g|png|webp|avif|gif)$/i.test(f.name)));
            await this.uploadFile(coverFile, folderId, `cover.${coverFile.name.split('.').pop()}`);
        }

        if (magnetLink?.trim()) await upsert('magnet.txt', magnetLink.trim());
        else if (clear.includes('magnet')) await remove(matching(n => n.startsWith('magnet') && n.endsWith('.txt')));

        // Sorozatnál a részek az episodes.json-ba, filmnél a link a stream.txt-be kerül — a másik
        // fájl ilyenkor elavult (pl. kategóriaváltás után), és felülírná az újat, ezért törlődik.
        const isSeries = category === 'Sorozat';
        const playback = this._playbackData({ seasons, episodes });
        if (isSeries && playback.cleaned.length) {
            await upsert('episodes.json', playback.json);
            await remove(named('stream.txt', 'streamtape.txt'));
        } else if (!isSeries && streamUrl?.trim()) {
            await upsert('stream.txt', toEmbedUrl(streamUrl));
            await remove(named('episodes.json', 'episodes.txt'));
        }
        if (clear.includes('stream')) await remove(named('stream.txt', 'streamtape.txt'));
        if (clear.includes('episodes')) {
            await remove(named('episodes.json', 'episodes.txt', ...(isSeries ? ['stream.txt', 'streamtape.txt'] : [])));
        }

        if (downloadUrl?.trim()) await upsert('download.txt', downloadUrl.trim());
        else if (clear.includes('download')) await remove(named('download.txt', 'letoltes.txt'));

        if (trailers?.length) await upsert('trailers.txt', trailers.join('\n'));
        else if (clear.includes('trailers')) await remove(named('trailers.txt', 'trailer.txt'));

        // Új torrent fájl a régit váltja (különben kettő lenne, és a véletlen döntene)
        if (torrentFile) {
            await remove(matching(n => n.endsWith('.torrent')));
            await this.uploadFile(torrentFile, folderId, torrentFile.name);
        }

        if (description?.trim()) await upsert('leiras.txt', description);
        else if (clear.includes('description')) {
            await remove(matching(n => n === 'description.txt' || (n.startsWith('leiras') && n.endsWith('.txt'))));
        }

        if (subtitlePlan) await this.syncSubtitles(folderId, subtitlePlan);

        this.clearCache();
        return { id: folderId };
    }

    // Tartalom mappájának törlése (minden fájlával együtt)
    async deleteTorrent(folderId) {
        const res = await this._deleteFile(folderId);
        if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
        this.clearCache();
    }
}

const driveAPI = new DriveAPI();
