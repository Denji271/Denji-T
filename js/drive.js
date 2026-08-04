class DriveAPI {
    constructor() {
        this.cache = new Map();
        this.categoryFolderIds = {}; // Maps category name to folder ID
    }

    // Get cached data or fetch fresh
    async getCached(key, fetchFn) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < CONFIG.CACHE_TTL) {
            return cached.data;
        }
        const data = await fetchFn();
        this.cache.set(key, { data, timestamp: Date.now() });
        return data;
    }

    // List folders in a parent folder
    async listFolders(parentId) {
        const url = `https://www.googleapis.com/drive/v3/files?q='${parentId}'+in+parents+and+mimeType='application/vnd.google-apps.folder'+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name,createdTime)&orderBy=name`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
        const data = await res.json();
        return data.files || [];
    }

    // List files in a folder
    async listFiles(folderId) {
        const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name,mimeType,size,createdTime,webContentLink,description)&orderBy=name`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
        const data = await res.json();
        return data.files || [];
    }

    // Read text file content (localhost proxy or OAuth only — alt=media&key gives 403)
    async readTextFile(fileId, torrentTitle = '') {
        if (!fileId) return '';

        const parseText = (text) => {
            if (!text) return '';
            if (text.includes('magnet:?')) {
                const match = text.match(/magnet:\?xt=urn:[^\s"']+/i);
                let uri = match ? match[0] : text.trim();
                if (!uri.toLowerCase().includes('&dn=') && torrentTitle) {
                    uri += `&dn=${encodeURIComponent(torrentTitle)}`;
                }
                return uri;
            }
            if (!text.includes('<!DOCTYPE html>') && !text.includes('<html>')) {
                return text.trim();
            }
            return '';
        };

        // Method 0: Read Google Drive file description metadata via API Key (Fastest & 100% reliable)
        if (CONFIG.GOOGLE_API_KEY) {
            try {
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), 2500);
                const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=description&key=${CONFIG.GOOGLE_API_KEY}`, { signal: controller.signal });
                clearTimeout(tid);
                if (res.ok) {
                    const data = await res.json();
                    if (data.description && data.description.trim()) {
                        const parsed = parseText(data.description.trim());
                        if (parsed) return parsed;
                    }
                }
            } catch (e) {}
        }

        // Method 1: Local server proxy (/api/read_text) — only on localhost
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            try {
                const titleParam = torrentTitle ? `&title=${encodeURIComponent(torrentTitle)}` : '';
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), 4000);
                const res = await fetch(`/api/read_text?id=${fileId}${titleParam}`, { signal: controller.signal });
                clearTimeout(tid);
                if (res.ok) {
                    const parsed = parseText(await res.text());
                    if (parsed) return parsed;
                }
            } catch (e) {}
        }

        // Method 2: OAuth access token (admin only)
        if (this.accessToken) {
            try {
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), 1500);
                const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${this.accessToken}` },
                    signal: controller.signal
                });
                clearTimeout(tid);
                if (res.ok) {
                    const parsed = parseText(await res.text());
                    if (parsed) return parsed;
                }
            } catch (e) {}
        }

        return '';
    }

    // Get cover image URL (Google CDN - works in all browsers including Brave with no CORS/referer restrictions)
    getCoverImageUrl(fileId) {
        return `https://lh3.googleusercontent.com/d/${fileId}`;
    }

    // Initialize: discover category folder IDs
    async init() {
        try {
            const rootFolders = await this.listFolders(CONFIG.DRIVE_ROOT_FOLDER_ID);
            for (const folder of rootFolders) {
                if (CONFIG.CATEGORIES[folder.name]) {
                    this.categoryFolderIds[folder.name] = folder.id;
                }
            }
        } catch (e) {
            console.error('Init error:', e);
        }
    }

    // Process a single torrent folder and extract its cover image, magnet link, torrent file, and description
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
            episodes: null, // legacy flat: [{ ep: 1, url: '...' }]
            seasons: null,  // [{ season: 1, episodes: [{ ep: 1, url }] }]
        };

        for (const file of files) {
            const nameLower = file.name.toLowerCase();
            const mime = file.mimeType || '';

            // 1. Cover Image: image mime type or common image extension
            if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(file.name)) {
                torrent.coverUrl = this.getCoverImageUrl(file.id);
            } 
            // 2. Torrent File
            else if (nameLower.endsWith('.torrent') || mime === 'application/x-bittorrent') {
                torrent.torrentFileId = file.id;
                torrent.torrentFileName = file.name;
            }
            // 3. Category file (kategoria.txt)
            else if (nameLower === 'kategoria.txt' || nameLower === 'category.txt') {
                if (file.description && file.description.trim()) {
                    torrent.category = file.description.trim();
                }
                this.readTextFile(file.id).then(catText => {
                    if (catText && catText.trim()) torrent.category = catText.trim();
                }).catch(() => {});
            }
            // 4. Stream file (stream.txt) — film single URL or series JSON
            else if (nameLower === 'stream.txt' || nameLower === 'streamtape.txt') {
                const applyStreamData = (raw) => {
                    if (!raw || !raw.trim()) return;
                    const text = raw.trim();
                    if (text.startsWith('{') || text.startsWith('[')) {
                        try {
                            const parsed = JSON.parse(text);
                            if (parsed.seasons && Array.isArray(parsed.seasons)) {
                                torrent.seasons = parsed.seasons.map((s, si) => ({
                                    season: s.season || (si + 1),
                                    episodes: (s.episodes || []).map((e, i) => ({
                                        ep: e.ep || (i + 1),
                                        url: (e.url || '').replace('streamtape.com/v/', 'streamtape.com/e/')
                                    })).filter(e => e.url)
                                })).filter(s => s.episodes.length);
                            } else {
                                const eps = parsed.episodes || (Array.isArray(parsed) ? parsed : null);
                                if (eps && eps.length) {
                                    torrent.episodes = eps.map((e, i) => ({
                                        ep: e.ep || (i + 1),
                                        url: (e.url || '').replace('streamtape.com/v/', 'streamtape.com/e/')
                                    })).filter(e => e.url);
                                }
                            }
                        } catch (e) {}
                    } else {
                        let sUrl = text;
                        if (sUrl.includes('streamtape.com/v/')) sUrl = sUrl.replace('streamtape.com/v/', 'streamtape.com/e/');
                        torrent.streamUrl = sUrl;
                    }
                };
                if (file.description) applyStreamData(file.description);
                this.readTextFile(file.id).then(applyStreamData).catch(() => {});
            }
            // 4b. episodes.json for series (supports seasons or flat episodes)
            else if (nameLower === 'episodes.json' || nameLower === 'episodes.txt') {
                const applyEps = (raw) => {
                    if (!raw || !raw.trim()) return;
                    try {
                        const parsed = JSON.parse(raw.trim());
                        if (parsed.seasons && Array.isArray(parsed.seasons)) {
                            torrent.seasons = parsed.seasons.map((s, si) => ({
                                season: s.season || (si + 1),
                                episodes: (s.episodes || []).map((e, i) => ({
                                    ep: e.ep || (i + 1),
                                    url: (e.url || '').replace('streamtape.com/v/', 'streamtape.com/e/')
                                })).filter(e => e.url)
                            })).filter(s => s.episodes.length);
                        } else {
                            const eps = parsed.episodes || (Array.isArray(parsed) ? parsed : null);
                            if (eps && eps.length) {
                                torrent.episodes = eps.map((e, i) => ({
                                    ep: e.ep || (i + 1),
                                    url: (e.url || '').replace('streamtape.com/v/', 'streamtape.com/e/')
                                })).filter(e => e.url);
                            }
                        }
                    } catch (e) {}
                };
                if (file.description) applyEps(file.description);
                this.readTextFile(file.id).then(applyEps).catch(() => {});
            }
            // 5. Download link file (download.txt, letoltes.txt)
            else if (nameLower === 'download.txt' || nameLower === 'letoltes.txt') {
                if (file.description && file.description.trim()) {
                    torrent.downloadUrl = file.description.trim();
                }
                this.readTextFile(file.id).then(t => {
                    if (t && t.trim()) torrent.downloadUrl = t.trim();
                }).catch(() => {});
            }
            // 6. YouTube trailer file (trailers.txt, trailer.txt)
            else if (nameLower === 'trailers.txt' || nameLower === 'trailer.txt') {
                if (file.description && file.description.trim()) {
                    torrent.trailers = file.description.trim().split('\n').map(u => u.trim()).filter(u => u);
                }
                this.readTextFile(file.id).then(t => {
                    if (t && t.trim()) {
                        torrent.trailers = t.trim().split('\n').map(u => u.trim()).filter(u => u);
                    }
                }).catch(() => {});
            }
            // 7. Description file (leiras.txt, description.txt)
            else if (nameLower === 'leiras.txt' || nameLower === 'description.txt' || nameLower.startsWith('leiras')) {
                torrent.descriptionFileId = file.id;
                if (file.description && file.description.trim()) {
                    torrent.description = file.description.trim();
                }
                this.readTextFile(file.id, folder.name).then(text => {
                    if (text && text.trim()) {
                        torrent.description = text.trim();
                        const descEl = document.querySelector('#detail-modal .detail-description');
                        if (descEl && window.app && window.app.currentDetailId === torrent.id) {
                            descEl.textContent = text.trim();
                        }
                    }
                }).catch(() => {});
            }
            // 8. Other text files (.txt)
            else if (nameLower.endsWith('.txt')) {
                if (nameLower === 'magnet.txt' || nameLower.startsWith('magnet')) {
                    torrent.magnetFileId = file.id;
                    if (file.description && file.description.includes('magnet:?')) {
                        const match = file.description.match(/magnet:\?xt=urn:[^\s"']+/i);
                        if (match) {
                            let uri = match[0];
                            if (!uri.toLowerCase().includes('&dn=')) {
                                uri += `&dn=${encodeURIComponent(folder.name)}`;
                            }
                            torrent.magnetLink = uri;
                        }
                    }
                }
                this.readTextFile(file.id, folder.name).then(text => {
                    if (text && text.includes('magnet:?')) {
                        const match = text.match(/magnet:\?xt=urn:[^\s"']+/i);
                        if (match) {
                            let uri = match[0];
                            if (!uri.toLowerCase().includes('&dn=')) {
                                uri += `&dn=${encodeURIComponent(folder.name)}`;
                            }
                            torrent.magnetLink = uri;
                        }
                    }
                }).catch(() => {});
            }
        }

        // Return torrent object IMMEDIATELY so page renders without waiting or hanging!
        return torrent;
    }

    // Load ALL torrents from both Category folders and Root directory
    async loadAllTorrents() {
        return this.getCached('all_torrents', async () => {
            const torrents = [];
            const rootFolders = await this.listFolders(CONFIG.DRIVE_ROOT_FOLDER_ID);

            for (const folder of rootFolders) {
                // Is this folder one of the known category folders (Játék, Film, Sorozat)?
                if (CONFIG.CATEGORIES[folder.name]) {
                    this.categoryFolderIds[folder.name] = folder.id;
                    const torrentFolders = await this.listFolders(folder.id);
                    for (const tFolder of torrentFolders) {
                        const torrent = await this.processTorrentFolder(tFolder, folder.name);
                        if (torrent) torrents.push(torrent);
                    }
                } else {
                    // It's a torrent folder placed directly in the root directory!
                    const torrent = await this.processTorrentFolder(folder, 'Játék');
                    if (torrent) torrents.push(torrent);
                }
            }

            return torrents;
        });
    }

    // Clear cache to force refresh
    clearCache() {
        this.cache.clear();
    }

    // One-time migration: reads magnet.txt/kategoria.txt content via OAuth and stores in file description
    // Run once from admin console: driveAPI.fixDescriptions()
    async fixDescriptions() {
        const token = await this.getAccessToken();
        const rootFolders = await this.listFolders(CONFIG.DRIVE_ROOT_FOLDER_ID);
        let fixed = 0;

        for (const folder of rootFolders) {
            const files = await this.listFiles(folder.id);
            // Check subfolders too (for category-based folder structure)
            const subFolders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
            const allFolders = subFolders.length > 0 ? subFolders : [folder];
            const isCategory = subFolders.length > 0;

            for (const tf of allFolders) {
                const tFiles = isCategory ? await this.listFiles(tf.id) : files;
                for (const file of tFiles) {
                    const nameLower = file.name.toLowerCase();
                    const isTargetFile = ['magnet.txt', 'kategoria.txt', 'leiras.txt', 'description.txt', 'stream.txt', 'download.txt', 'trailers.txt', 'trailer.txt', 'letoltes.txt'].includes(nameLower);
                    if (isTargetFile && !file.description) {
                        try {
                            // Read content via OAuth
                            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
                                headers: { 'Authorization': `Bearer ${token}` }
                            });
                            if (res.ok) {
                                const text = (await res.text()).trim();
                                if (text) {
                                    // Set description
                                    await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}`, {
                                        method: 'PATCH',
                                        headers: {
                                            'Authorization': `Bearer ${token}`,
                                            'Content-Type': 'application/json'
                                        },
                                        body: JSON.stringify({ description: text })
                                    });
                                    console.log(`✅ Fixed description for ${tf.name}/${file.name}: ${text.substring(0, 60)}...`);
                                    fixed++;
                                }
                            }
                        } catch (e) {
                            console.error(`❌ Failed for ${tf.name}/${file.name}:`, e);
                        }
                    }
                }
            }
        }
        console.log(`Done! Fixed ${fixed} file descriptions.`);
    }

    // Google OAuth2 - initialize the Google Identity Services
    initOAuth() {
        const clientId = CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('denjit_client_id');
        if (!clientId) return false;
        
        if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
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
                        if (this._oauthReject) {
                            this._oauthReject(new Error(`OAuth hiba: ${response.error}`));
                            this._oauthReject = null;
                        }
                        return;
                    }
                    this.accessToken = response.access_token;
                    if (this._oauthResolve) {
                        this._oauthResolve(this.accessToken);
                        this._oauthResolve = null;
                    }
                }
            });
            return true;
        } catch (e) {
            console.error('Failed to init OAuth:', e);
            return false;
        }
    }

    // Request OAuth token (prompts Google sign-in)
    async getAccessToken() {
        if (this.accessToken) return this.accessToken;

        let clientId = CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('denjit_client_id');
        if (!clientId) {
            clientId = prompt('A Google Drive közvetlen feltöltéshez meg kell adnod a Google OAuth Client ID-t!\n\nHa nem állítottál be Client ID-t, a legegyszerűbb közvetlenül a Google Drive mappádban létrehozni az almappát.\n\nHa van Client ID-d, írd be ide:');
            if (clientId && clientId.trim()) {
                clientId = clientId.trim();
                localStorage.setItem('denjit_client_id', clientId);
                CONFIG.GOOGLE_CLIENT_ID = clientId;
            } else {
                throw new Error('OAuth Client ID szükséges a weboldalon belüli feltöltéshez! (Használd a "Megnyitás Drive-ban" gombot a manuális feltöltéshez)');
            }
        }

        if (!this.tokenClient) {
            const ok = this.initOAuth();
            if (!ok) {
                throw new Error('Nem sikerült az OAuth kliens inicializálása. Ellenőrizd a Client ID-t!');
            }
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

    // Create a folder in a parent folder
    async createFolder(name, parentId) {
        const token = await this.getAccessToken();
        const res = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId]
            })
        });
        if (!res.ok) throw new Error(`Failed to create folder: ${res.status}`);
        return await res.json();
    }

    // Upload a file to a folder (with optional description metadata)
    async uploadFile(file, folderId, fileName, fileDescription = '') {
        const token = await this.getAccessToken();
        const metadata = {
            name: fileName || file.name,
            parents: [folderId]
        };
        if (fileDescription) {
            // Drive description soft limit ~100KB; keep safe
            metadata.description = String(fileDescription).slice(0, 90000);
        }

        const formData = new FormData();
        formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        formData.append('file', file);

        const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: formData
        });
        if (!res.ok) {
            let detail = '';
            try { detail = await res.text(); } catch (e) {}
            console.error('Drive upload error:', res.status, detail);
            throw new Error(`Failed to upload file: ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
        }
        return await res.json();
    }

    // Upload a text file with optional description (description is used for metadata-only access on GitHub Pages)
    async uploadTextFile(content, folderId, fileName, fileDescription = '') {
        const blob = new Blob([content], { type: 'text/plain' });
        const file = new File([blob], fileName, { type: 'text/plain' });
        return this.uploadFile(file, folderId, fileName, fileDescription);
    }

    // Add a new torrent: creates folder directly in root Drive folder + uploads files
    async addTorrent({ title, category, coverFile, magnetLink, torrentFile, description, streamUrl, downloadUrl, trailers, seasons, episodes }) {
        // Create the torrent folder directly inside the root Google Drive folder
        const folder = await this.createFolder(title, CONFIG.DRIVE_ROOT_FOLDER_ID);

        // Upload kategoria.txt
        if (category) {
            await this.uploadTextFile(category, folder.id, 'kategoria.txt', category);
        }

        // Upload cover image
        if (coverFile) {
            const ext = coverFile.name.split('.').pop();
            await this.uploadFile(coverFile, folder.id, `cover.${ext}`);
        }

        // Upload magnet.txt
        if (magnetLink) {
            await this.uploadTextFile(magnetLink.trim(), folder.id, 'magnet.txt', magnetLink.trim());
        }

        // Series seasons OR legacy flat episodes OR single film stream
        if (seasons && seasons.length > 0) {
            const cleaned = seasons.map((s, si) => ({
                season: s.season || (si + 1),
                episodes: (s.episodes || []).map((e, i) => ({
                    ep: e.ep || (i + 1),
                    url: (e.url || '').trim().replace('streamtape.com/v/', 'streamtape.com/e/')
                })).filter(e => e.url)
            })).filter(s => s.episodes.length);
            if (cleaned.length) {
                const json = JSON.stringify({ seasons: cleaned });
                await this.uploadTextFile(json, folder.id, 'episodes.json', json);
            }
        } else if (episodes && episodes.length > 0) {
            const cleaned = episodes.map((e, i) => ({
                ep: e.ep || (i + 1),
                url: (e.url || '').trim().replace('streamtape.com/v/', 'streamtape.com/e/')
            })).filter(e => e.url);
            if (cleaned.length) {
                const json = JSON.stringify({ seasons: [{ season: 1, episodes: cleaned }] });
                await this.uploadTextFile(json, folder.id, 'episodes.json', json);
            }
        } else if (streamUrl) {
            let cleanStream = streamUrl.trim();
            if (cleanStream.includes('streamtape.com/v/')) {
                cleanStream = cleanStream.replace('streamtape.com/v/', 'streamtape.com/e/');
            }
            await this.uploadTextFile(cleanStream, folder.id, 'stream.txt', cleanStream);
        }

        // Upload download.txt
        if (downloadUrl) {
            await this.uploadTextFile(downloadUrl.trim(), folder.id, 'download.txt', downloadUrl.trim());
        }

        // Upload trailers.txt
        if (trailers && trailers.length > 0) {
            const trailersContent = trailers.join('\n');
            await this.uploadTextFile(trailersContent, folder.id, 'trailers.txt', trailersContent);
        }

        // Upload .torrent file
        if (torrentFile) {
            await this.uploadFile(torrentFile, folder.id, torrentFile.name);
        }

        // Upload leiras.txt
        if (description) {
            await this.uploadTextFile(description, folder.id, 'leiras.txt', description);
        }

        this.clearCache();
        return folder;
    }

    // Update existing text file by name inside a folder (or create if missing)
    async upsertTextFile(folderId, fileName, content) {
        const token = await this.getAccessToken();
        const files = await this.listFiles(folderId);
        const existing = files.find(f => f.name.toLowerCase() === fileName.toLowerCase());

        if (existing) {
            // Update description (metadata)
            await fetch(`https://www.googleapis.com/drive/v3/files/${existing.id}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ description: content })
            });
            // Update content
            await fetch(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'text/plain'
                },
                body: content
            });
            return existing;
        } else {
            return this.uploadTextFile(content, folderId, fileName, content);
        }
    }

    // Update an existing torrent (edit)
    async updateTorrent(folderId, { title, category, coverFile, magnetLink, torrentFile, description, streamUrl, downloadUrl, trailers, seasons, episodes }) {
        const token = await this.getAccessToken();

        // Rename folder if title changed
        if (title) {
            await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: title })
            });
        }

        if (category) {
            await this.upsertTextFile(folderId, 'kategoria.txt', category);
        }

        if (coverFile) {
            const files = await this.listFiles(folderId);
            const oldCover = files.find(f => (f.mimeType || '').startsWith('image/') || /\.(jpg|jpeg|png|webp|gif)$/i.test(f.name));
            if (oldCover) {
                await fetch(`https://www.googleapis.com/drive/v3/files/${oldCover.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
            }
            const ext = coverFile.name.split('.').pop();
            await this.uploadFile(coverFile, folderId, `cover.${ext}`);
        }

        if (magnetLink !== undefined && magnetLink !== null) {
            if (magnetLink.trim()) {
                await this.upsertTextFile(folderId, 'magnet.txt', magnetLink.trim());
            }
        }

        // Seasons / episodes (series) or single stream (film)
        if (seasons && seasons.length > 0) {
            const cleaned = seasons.map((s, si) => ({
                season: s.season || (si + 1),
                episodes: (s.episodes || []).map((e, i) => ({
                    ep: e.ep || (i + 1),
                    url: (e.url || '').trim().replace('streamtape.com/v/', 'streamtape.com/e/')
                })).filter(e => e.url)
            })).filter(s => s.episodes.length);
            const json = JSON.stringify({ seasons: cleaned });
            await this.upsertTextFile(folderId, 'episodes.json', json);
        } else if (episodes && episodes.length > 0) {
            const cleaned = episodes.map((e, i) => ({
                ep: e.ep || (i + 1),
                url: (e.url || '').trim().replace('streamtape.com/v/', 'streamtape.com/e/')
            })).filter(e => e.url);
            const json = JSON.stringify({ seasons: [{ season: 1, episodes: cleaned }] });
            await this.upsertTextFile(folderId, 'episodes.json', json);
        } else if (streamUrl !== undefined && streamUrl !== null) {
            if (streamUrl.trim()) {
                let clean = streamUrl.trim().replace('streamtape.com/v/', 'streamtape.com/e/');
                await this.upsertTextFile(folderId, 'stream.txt', clean);
            }
        }

        if (downloadUrl !== undefined && downloadUrl !== null) {
            if (downloadUrl.trim()) {
                await this.upsertTextFile(folderId, 'download.txt', downloadUrl.trim());
            }
        }

        if (trailers && trailers.length > 0) {
            await this.upsertTextFile(folderId, 'trailers.txt', trailers.join('\n'));
        }

        if (torrentFile) {
            await this.uploadFile(torrentFile, folderId, torrentFile.name);
        }

        if (description !== undefined && description !== null) {
            if (description.trim()) {
                await this.upsertTextFile(folderId, 'leiras.txt', description);
            }
        }

        this.clearCache();
        return { id: folderId };
    }

    // Delete a torrent folder (and all contents)
    async deleteTorrent(folderId) {
        const token = await this.getAccessToken();
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}`, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
        this.clearCache();
    }
}

const driveAPI = new DriveAPI();
