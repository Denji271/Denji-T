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

/* A beágyazható Streamtape forma /e/, a megosztott link /v/ */
const toEmbedUrl = (url) => String(url || '').trim().replace('streamtape.com/v/', 'streamtape.com/e/');

/* A torrent kliensek a &dn= paraméterből veszik a letöltés nevét */
const withDisplayName = (uri, title) =>
    (title && !uri.toLowerCase().includes('&dn=')) ? `${uri}&dn=${encodeURIComponent(title)}` : uri;

/* Csak akkor ad vissza linket, ha a szövegben valódi magnet URI van */
function findMagnet(text, title) {
    const match = String(text || '').match(MAGNET_RE);
    return match ? withDisplayName(match[0], title) : '';
}

/* Évad/rész listák egységesítése — ugyanaz a forma olvasáskor és mentéskor */
function cleanSeasons(seasons) {
    return (seasons || []).map((s, si) => ({
        season: s.season || (si + 1),
        episodes: cleanEpisodes(s.episodes)
    })).filter(s => s.episodes.length);
}

function cleanEpisodes(episodes) {
    return (episodes || []).map((e, i) => ({
        ep: e.ep || (i + 1),
        url: toEmbedUrl(e.url)
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
            const slim = (torrents || []).map(t => ({
                ...t,
                description: t.description ? String(t.description).slice(0, 600) : t.description
            }));
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
    async _listChildren(parentId, fields, extraQuery = '') {
        const q = `'${parentId}'+in+parents+and+trashed=false${extraQuery}`;
        const res = await fetch(`${DRIVE_FILES}?q=${q}&key=${CONFIG.GOOGLE_API_KEY}&fields=files(${fields})&orderBy=name`);
        if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
        return (await res.json()).files || [];
    }

    listFolders(parentId) {
        return this._listChildren(parentId, 'id,name,createdTime', `+and+mimeType='application/vnd.google-apps.folder'`);
    }

    listFiles(folderId) {
        return this._listChildren(folderId, 'id,name,mimeType,size,createdTime,webContentLink,description');
    }

    // Szövegfájl beolvasása (alt=media + API kulcs 403-at ad, ezért a kerülőutak)
    async readTextFile(fileId, torrentTitle = '') {
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
        if (CONFIG.GOOGLE_API_KEY) {
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
                const res = await fetchWithTimeout(apiUrl(`/api/read_text?id=${fileId}${titleParam}`), 4000);
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

        /* A tartalom kétszer érkezhet: azonnal a description mezőből, majd — ha az üres
           volt vagy frissebb a fájl — a beolvasott szövegből. Mindkettőre ugyanaz fut. */
        const hydrate = (file, apply, title = '') => {
            if (file.description?.trim()) apply(file.description.trim());
            this.readTextFile(file.id, title).then(text => {
                if (text?.trim()) apply(text.trim());
            }).catch(() => {});
        };

        const applyStreamText = (text) => {
            if (text.startsWith('{') || text.startsWith('[')) {
                try {
                    applyEpisodeData(torrent, JSON.parse(text));
                } catch (e) {}
            } else {
                torrent.streamUrl = toEmbedUrl(text);
            }
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
                hydrate(file, (text) => {
                    try {
                        applyEpisodeData(torrent, JSON.parse(text));
                    } catch (e) {}
                });
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
                if (nameLower.startsWith('magnet')) {
                    torrent.magnetFileId = file.id;
                    const fromDescription = findMagnet(file.description, folder.name);
                    if (fromDescription) torrent.magnetLink = fromDescription;
                }
                this.readTextFile(file.id, folder.name).then(text => {
                    const magnet = findMagnet(text, folder.name);
                    if (magnet) torrent.magnetLink = magnet;
                }).catch(() => {});
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

    // Meglévő szövegfájl frissítése név alapján (ha nincs, létrehozza)
    async upsertTextFile(folderId, fileName, content) {
        const token = await this.getAccessToken();
        const files = await this.listFiles(folderId);
        const existing = files.find(f => f.name.toLowerCase() === fileName.toLowerCase());
        if (!existing) return this.uploadTextFile(content, folderId, fileName, content);

        await this._patchFile(existing.id, { description: content });
        await fetch(`${DRIVE_UPLOAD}/${existing.id}?uploadType=media`, {
            method: 'PATCH',
            headers: authHeaders(token, 'text/plain'),
            body: content
        });
        return existing;
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
    async addTorrent({ title, category, coverFile, magnetLink, torrentFile, description, streamUrl, downloadUrl, trailers, seasons, episodes, isMagyar }) {
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

        this.clearCache();
        return folder;
    }

    // Meglévő tartalom szerkesztése
    async updateTorrent(folderId, { title, category, coverFile, magnetLink, torrentFile, description, streamUrl, downloadUrl, trailers, seasons, episodes, isMagyar }) {
        if (title) await this._patchFile(folderId, { name: title });
        if (category) await this.upsertTextFile(folderId, 'kategoria.txt', category);

        // Szerkesztéskor: BE → magyar.txt létrehozása, KI → magyar.txt törlése
        if (isMagyar !== undefined && isMagyar !== null) {
            const existingMagyar = (await this.listFiles(folderId)).find(f => {
                const n = (f.name || '').toLowerCase();
                return n === 'magyar.txt' || n === 'is_magyar.txt';
            });
            if (isMagyar === true) {
                if (!existingMagyar) await this.uploadTextFile('true', folderId, 'magyar.txt', 'true');
            } else if (existingMagyar) {
                await this._deleteFile(existingMagyar.id);
            }
        }

        if (coverFile) {
            const oldCover = (await this.listFiles(folderId)).find(f =>
                (f.mimeType || '').startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name));
            if (oldCover) await this._deleteFile(oldCover.id);
            await this.uploadFile(coverFile, folderId, `cover.${coverFile.name.split('.').pop()}`);
        }

        if (magnetLink?.trim()) await this.upsertTextFile(folderId, 'magnet.txt', magnetLink.trim());

        // Évadok / epizódok (sorozat) vagy egyetlen stream (film)
        const playback = this._playbackData({ seasons, episodes });
        if (playback.requested) {
            await this.upsertTextFile(folderId, 'episodes.json', playback.json);
        } else if (streamUrl?.trim()) {
            await this.upsertTextFile(folderId, 'stream.txt', toEmbedUrl(streamUrl));
        }

        if (downloadUrl?.trim()) await this.upsertTextFile(folderId, 'download.txt', downloadUrl.trim());
        if (trailers?.length) await this.upsertTextFile(folderId, 'trailers.txt', trailers.join('\n'));
        if (torrentFile) await this.uploadFile(torrentFile, folderId, torrentFile.name);
        if (description?.trim()) await this.upsertTextFile(folderId, 'leiras.txt', description);

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
