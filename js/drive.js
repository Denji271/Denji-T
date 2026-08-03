class DriveAPI {
    constructor() {
        this.cache = new Map();
        this.categoryFolderIds = {}; // Maps category name to folder ID
        this.passcodesFileId = null;
    }

    // Fetch passcodes.json from Google Drive root folder so passcodes are synced across all devices!
    async loadPasscodesFromDrive() {
        if (!CONFIG.GOOGLE_API_KEY || !CONFIG.DRIVE_ROOT_FOLDER_ID) return null;
        try {
            const url = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_ROOT_FOLDER_ID}'+in+parents+and+name='passcodes.json'+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name)`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = await res.json();
            const files = data.files || [];
            if (files.length > 0) {
                const fileId = files[0].id;
                this.passcodesFileId = fileId;
                const fileUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${CONFIG.GOOGLE_API_KEY}`;
                const textRes = await fetch(fileUrl);
                if (textRes.ok) {
                    const text = await textRes.text();
                    if (text && text.trim().startsWith('[')) {
                        const passcodes = JSON.parse(text.trim());
                        if (Array.isArray(passcodes)) {
                            localStorage.setItem('denjit_passcodes', JSON.stringify(passcodes));
                            return passcodes;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Failed to load passcodes from Drive:', e);
        }
        return null;
    }

    // Save passcodes.json to Google Drive root folder
    async savePasscodesToDrive(passcodes) {
        if (!CONFIG.DRIVE_ROOT_FOLDER_ID) return;
        const content = JSON.stringify(passcodes, null, 2);
        try {
            const token = await this.getAccessToken();
            if (!this.passcodesFileId) {
                const url = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_ROOT_FOLDER_ID}'+in+parents+and+name='passcodes.json'+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name)`;
                const res = await fetch(url);
                if (res.ok) {
                    const data = await res.json();
                    if (data.files && data.files.length > 0) {
                        this.passcodesFileId = data.files[0].id;
                    }
                }
            }

            if (this.passcodesFileId) {
                await fetch(`https://www.googleapis.com/upload/drive/v3/files/${this.passcodesFileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: content
                });
            } else {
                const file = await this.uploadTextFile(content, CONFIG.DRIVE_ROOT_FOLDER_ID, 'passcodes.json', content);
                if (file && file.id) this.passcodesFileId = file.id;
            }
        } catch (e) {
            console.error('Failed to save passcodes to Drive:', e);
        }
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
        const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name,mimeType,size,createdTime,webContentLink)&orderBy=name`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
        const data = await res.json();
        return data.files || [];
    }

    // Read text file content using Google Drive API key (alt=media) — 100% works everywhere!
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

        // Method 1: Google Drive API Key alt=media (Works on GitHub Pages, localhost, Brave, Chrome, Edge!)
        if (CONFIG.GOOGLE_API_KEY) {
            try {
                const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${CONFIG.GOOGLE_API_KEY}`;
                const res = await fetch(url);
                if (res.ok) {
                    const parsed = parseText(await res.text());
                    if (parsed) return parsed;
                }
            } catch (e) {}
        }

        // Method 2: Local server proxy (/api/read_text) ONLY if running locally
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
            try {
                const titleParam = torrentTitle ? `&title=${encodeURIComponent(torrentTitle)}` : '';
                const controller = new AbortController();
                const tid = setTimeout(() => controller.abort(), 1000);
                const res = await fetch(`/api/read_text?id=${fileId}${titleParam}`, { signal: controller.signal });
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
        };

        const textPromises = [];

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
                textPromises.push(
                    this.readTextFile(file.id).then(catText => {
                        if (catText && catText.trim()) torrent.category = catText.trim();
                    }).catch(() => {})
                );
            }
            // 4. Text files (.txt)
            else if (nameLower.endsWith('.txt')) {
                if (nameLower === 'magnet.txt' || nameLower.startsWith('magnet')) {
                    torrent.magnetFileId = file.id;
                }
                textPromises.push(
                    this.readTextFile(file.id, folder.name).then(text => {
                        if (text) {
                            if (text.includes('magnet:?')) {
                                const match = text.match(/magnet:\?xt=urn:[^\s"']+/i);
                                if (match) {
                                    let uri = match[0];
                                    if (!uri.toLowerCase().includes('&dn=')) {
                                        uri += `&dn=${encodeURIComponent(folder.name)}`;
                                    }
                                    torrent.magnetLink = uri;
                                }
                            } else if (nameLower === 'leiras.txt' || nameLower === 'description.txt' || !torrent.description) {
                                torrent.description = text;
                            }
                        }
                    }).catch(() => {})
                );
            }
        }

        // Wait for text reads (takes ~200ms via Drive API key)
        await Promise.all(textPromises);

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

    // Upload a file to a folder
    async uploadFile(file, folderId, fileName) {
        const token = await this.getAccessToken();
        const metadata = {
            name: fileName || file.name,
            parents: [folderId]
        };

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
        if (!res.ok) throw new Error(`Failed to upload file: ${res.status}`);
        return await res.json();
    }

    // Upload a text file (for magnet.txt, leiras.txt)
    async uploadTextFile(content, folderId, fileName) {
        const blob = new Blob([content], { type: 'text/plain' });
        const file = new File([blob], fileName, { type: 'text/plain' });
        return this.uploadFile(file, folderId, fileName);
    }

    // Add a new torrent: creates folder directly in root Drive folder + uploads files
    async addTorrent({ title, category, coverFile, magnetLink, torrentFile, description }) {
        // Create the torrent folder directly inside the root Google Drive folder
        const folder = await this.createFolder(title, CONFIG.DRIVE_ROOT_FOLDER_ID);

        // Upload kategoria.txt so the website knows the category (Játék / Film / Sorozat)
        if (category) {
            await this.uploadTextFile(category, folder.id, 'kategoria.txt');
        }

        // Upload cover image
        if (coverFile) {
            const ext = coverFile.name.split('.').pop();
            await this.uploadFile(coverFile, folder.id, `cover.${ext}`);
        }

        // Upload magnet.txt
        if (magnetLink) {
            await this.uploadTextFile(magnetLink.trim(), folder.id, 'magnet.txt');
        }

        // Upload .torrent file
        if (torrentFile) {
            await this.uploadFile(torrentFile, folder.id, torrentFile.name);
        }

        // Upload leiras.txt
        if (description) {
            await this.uploadTextFile(description, folder.id, 'leiras.txt');
        }

        // Clear cache to refresh
        this.clearCache();

        return folder;
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
