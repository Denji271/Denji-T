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
        const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,name,mimeType,size,createdTime,webContentLink)&orderBy=name`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
        const data = await res.json();
        return data.files || [];
    }

    // Read text file content (magnet.txt, leiras.txt)
    async readTextFile(fileId) {
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${CONFIG.GOOGLE_API_KEY}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
        return await res.text();
    }

    // Get cover image URL
    getCoverImageUrl(fileId) {
        return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
    }

    // Initialize: discover category folder IDs
    async init() {
        const rootFolders = await this.listFolders(CONFIG.DRIVE_ROOT_FOLDER_ID);
        for (const folder of rootFolders) {
            if (CONFIG.CATEGORIES[folder.name]) {
                this.categoryFolderIds[folder.name] = folder.id;
            }
        }
    }

    // Process a single torrent folder and extract its cover image, magnet link, torrent file, and description
    async processTorrentFolder(folder, defaultCategory = 'Játék') {
        const files = await this.listFiles(folder.id);
        const torrent = {
            id: folder.id,
            title: folder.name,
            category: defaultCategory,
            createdTime: folder.createdTime,
            coverUrl: null,
            magnetLink: null,
            torrentFileId: null,
            torrentFileName: null,
            description: null,
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
            // 3. Text files (.txt)
            else if (nameLower.endsWith('.txt')) {
                try {
                    const text = await this.readTextFile(file.id);
                    const trimmed = text ? text.trim() : '';
                    if (trimmed.startsWith('magnet:?')) {
                        torrent.magnetLink = trimmed;
                    } else if (nameLower === 'leiras.txt' || nameLower === 'description.txt' || !torrent.description) {
                        torrent.description = trimmed;
                    }
                } catch (e) {
                    console.error('Failed to read text file:', file.name, e);
                }
            }
        }

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

    // Add a new torrent: creates folder + uploads files
    async addTorrent({ title, category, coverFile, magnetLink, torrentFile, description }) {
        // Get or create the category folder ID
        let categoryFolderId = this.categoryFolderIds[category];
        if (!categoryFolderId) {
            const rootFolders = await this.listFolders(CONFIG.DRIVE_ROOT_FOLDER_ID);
            const found = rootFolders.find(f => f.name === category);
            if (found) {
                categoryFolderId = found.id;
            } else {
                const newCat = await this.createFolder(category, CONFIG.DRIVE_ROOT_FOLDER_ID);
                categoryFolderId = newCat.id;
            }
            this.categoryFolderIds[category] = categoryFolderId;
        }

        // Create the torrent folder
        const folder = await this.createFolder(title, categoryFolderId);

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
