class App {
    constructor() {
        this.torrents = [];           // All loaded torrents
        this.filteredTorrents = [];   // After search/filter
        this.currentFilters = {
            search: '',
            categories: new Set(['Játék', 'Film', 'Sorozat']), // All selected by default
            sort: 'name-asc'  // name-asc, name-desc, date-new, date-old
        };
    }

    // Initialize the app
    async init() {
        // Load passcodes from Google Drive so friends on other devices can log in
        try {
            await this.syncPasscodesFromDrive();
        } catch (e) {}

        // Check login state
        if (isLoggedIn()) {
            this.showMainPage();
        } else {
            this.showLoginPage();
        }
        this.bindEvents();
    }

    // Fetch passcodes from Google Drive root folder (reads file description metadata — no 403!)
    async syncPasscodesFromDrive() {
        if (!CONFIG.GOOGLE_API_KEY || !CONFIG.DRIVE_ROOT_FOLDER_ID) return;
        try {
            // Find passcodes.json in root folder — description field contains the passcode JSON
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 3000);
            const searchUrl = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_ROOT_FOLDER_ID}'+in+parents+and+name='passcodes.json'+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,description)`;
            const searchRes = await fetch(searchUrl, { signal: controller.signal });
            clearTimeout(tid);
            if (!searchRes.ok) return;
            const searchData = await searchRes.json();
            const files = searchData.files || [];
            if (files.length === 0) return;

            // Read passcodes from file description (metadata, not file content — works with API key!)
            const desc = files[0].description;
            if (desc && desc.trim().startsWith('[')) {
                const passcodes = JSON.parse(desc.trim());
                if (Array.isArray(passcodes) && passcodes.length > 0) {
                    localStorage.setItem('denjit_passcodes', JSON.stringify(passcodes));
                }
            }
        } catch (e) {
            console.log('Passcode sync skipped:', e.message);
        }
    }

    showLoginPage() {
        document.getElementById('login-page').classList.add('active');
        document.getElementById('main-page').classList.remove('active');
    }

    async showMainPage() {
        document.getElementById('login-page').classList.remove('active');
        document.getElementById('main-page').classList.add('active');
        
        const user = getCurrentUser();
        const greetingEl = document.getElementById('user-greeting');
        if (greetingEl && user) {
            greetingEl.textContent = user.displayName || user.username;
        }

        // Show admin UI elements if user is admin
        if (isAdmin()) {
            document.body.classList.add('admin-mode');
            document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'inline-flex');
        } else {
            document.body.classList.remove('admin-mode');
            document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
        }

        // Check if API key is configured
        if (!CONFIG.GOOGLE_API_KEY) {
            this.showConfigWarning();
            return;
        }

        // Load data
        await this.loadTorrents();

        // Initialize OAuth if admin and client ID is set
        if (isAdmin() && (CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('denjit_client_id'))) {
            driveAPI.initOAuth();
        }
    }

    showConfigWarning() {
        const grid = document.getElementById('torrent-grid');
        grid.innerHTML = `
            <div class="config-warning">
                <div class="config-warning-icon">⚙️</div>
                <h2>Konfiguráció szükséges</h2>
                <p>A Google Drive API használatához add meg az API kulcsot a <code>js/config.js</code> fájlban.</p>
                <ol>
                    <li>Hozz létre egy Google Cloud projektet</li>
                    <li>Engedélyezd a Google Drive API-t</li>
                    <li>Hozz létre egy API kulcsot</li>
                    <li>Írd be a <code>CONFIG.GOOGLE_API_KEY</code> mezőbe</li>
                </ol>
            </div>
        `;
    }

    async loadTorrents() {
        this.showLoading(true);
        try {
            await driveAPI.init();
            this.torrents = await driveAPI.loadAllTorrents();
            this.applyFilters();
        } catch (error) {
            console.error('Failed to load torrents:', error);
            this.showError('Hiba történt az adatok betöltésekor. Ellenőrizd a Google Drive beállításokat.');
        } finally {
            this.showLoading(false);
        }
    }

    applyFilters() {
        let results = [...this.torrents];

        // Search filter
        if (this.currentFilters.search) {
            const query = this.currentFilters.search.toLowerCase();
            results = results.filter(t => t.title.toLowerCase().includes(query));
        }

        // Category filter
        results = results.filter(t => this.currentFilters.categories.has(t.category));

        // Sort
        switch (this.currentFilters.sort) {
            case 'name-asc':
                results.sort((a, b) => a.title.localeCompare(b.title, 'hu'));
                break;
            case 'name-desc':
                results.sort((a, b) => b.title.localeCompare(a.title, 'hu'));
                break;
            case 'date-new':
                results.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
                break;
            case 'date-old':
                results.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
                break;
        }

        this.filteredTorrents = results;
        this.renderGrid();
    }

    renderGrid() {
        const grid = document.getElementById('torrent-grid');
        
        if (this.filteredTorrents.length === 0) {
            grid.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">🔍</div>
                    <h3>Nincs találat</h3>
                    <p>Próbálj más keresési feltételt vagy kategóriát.</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = this.filteredTorrents.map((torrent, index) => {
            const categoryInfo = CONFIG.CATEGORIES[torrent.category] || { emoji: '📁', color: '#888' };
            const coverStyle = torrent.coverUrl 
                ? `background-image: url('${torrent.coverUrl}')` 
                : `background: linear-gradient(135deg, ${categoryInfo.color}33, ${categoryInfo.color}11)`;
            
            const dateStr = torrent.createdTime 
                ? new Date(torrent.createdTime).toLocaleDateString('hu-HU')
                : '';

            return `
                <div class="torrent-card" style="--card-index: ${index}" data-id="${torrent.id}">
                    <div class="card-cover">
                        ${torrent.coverUrl ? `<img src="${torrent.coverUrl}" referrerpolicy="no-referrer" class="card-cover-img" alt="${this.escapeHtml(torrent.title)}">` : `<div class="card-cover-placeholder">${categoryInfo.emoji}</div>`}
                        <span class="category-badge" style="background: ${categoryInfo.color}">${categoryInfo.emoji} ${torrent.category}</span>
                    </div>
                    <div class="card-body">
                        <h3 class="card-title" title="${torrent.title}">${torrent.title}</h3>
                        ${dateStr ? `<p class="card-date">${dateStr}</p>` : ''}
                        <div class="card-actions">
                            ${(torrent.magnetLink || torrent.magnetFileId) ? `<button class="btn btn-magnet" onclick="event.stopPropagation(); app.openMagnet('${torrent.id}')" title="Megnyitás Deluge / Torrent klienssel">🧲 Magnet</button>` : ''}
                            ${torrent.torrentFileId ? `<button class="btn btn-torrent" onclick="app.downloadTorrent('${torrent.torrentFileId}', '${this.escapeHtml(torrent.torrentFileName)}')" title="Torrent fájl letöltése">📥 Torrent</button>` : ''}
                        </div>
                    </div>
                    ${isAdmin() ? `<button class="card-delete-btn" onclick="event.stopPropagation(); app.confirmDelete('${torrent.id}', '${this.escapeHtml(torrent.title)}')" title="Törlés">🗑️</button>` : ''}
                </div>
            `;
        }).join('');
    }

    // Event bindings
    bindEvents() {
        // Login mode tabs (Passcode vs Admin)
        document.querySelectorAll('.login-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.login-mode-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.login-form-view').forEach(f => f.classList.remove('active'));
                btn.classList.add('active');
                const mode = btn.dataset.mode;
                if (mode === 'passcode') {
                    document.getElementById('passcode-login-form')?.classList.add('active');
                } else {
                    document.getElementById('login-form')?.classList.add('active');
                }
            });
        });

        // Passcode login form
        const passcodeForm = document.getElementById('passcode-login-form');
        if (passcodeForm) {
            passcodeForm.addEventListener('submit', (e) => {
                e.preventDefault();
                const code = document.getElementById('passcode-input').value;
                const errorEl = document.getElementById('passcode-error');
                const res = loginWithPasscode(code);
                if (res.success) {
                    errorEl.textContent = '';
                    this.showMainPage();
                } else {
                    errorEl.textContent = res.error;
                    errorEl.classList.add('shake');
                    setTimeout(() => errorEl.classList.remove('shake'), 600);
                }
            });
        }

        // Admin login form
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const username = document.getElementById('username-input').value;
                const password = document.getElementById('password-input').value;
                const errorEl = document.getElementById('login-error');
                
                const res = await loginWithPassword(username, password);
                if (res.success) {
                    errorEl.textContent = '';
                    this.showMainPage();
                } else {
                    errorEl.textContent = res.error;
                    errorEl.classList.add('shake');
                    setTimeout(() => errorEl.classList.remove('shake'), 600);
                }
            });
        }

        // Logout
        document.getElementById('logout-btn')?.addEventListener('click', logout);

        // Search
        document.getElementById('search-input')?.addEventListener('input', (e) => {
            this.currentFilters.search = e.target.value;
            this.applyFilters();
        });

        // Category filters
        document.querySelectorAll('.category-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const category = e.target.dataset.category;
                if (e.target.checked) {
                    this.currentFilters.categories.add(category);
                } else {
                    this.currentFilters.categories.delete(category);
                }
                this.applyFilters();
            });
        });

        // Sort
        document.getElementById('sort-select')?.addEventListener('change', (e) => {
            this.currentFilters.sort = e.target.value;
            this.applyFilters();
        });

        // Add button
        document.getElementById('add-btn')?.addEventListener('click', () => {
            document.getElementById('add-modal').classList.add('active');
        });

        // Open Drive button (simplified option)
        document.getElementById('open-drive-btn')?.addEventListener('click', () => {
            window.open(`https://drive.google.com/drive/folders/${CONFIG.DRIVE_ROOT_FOLDER_ID}`, '_blank');
        });

        // Manage passcodes button (admin)
        document.getElementById('manage-passcodes-btn')?.addEventListener('click', () => {
            this.renderPasscodeList();
            document.getElementById('passcode-modal').classList.add('active');
        });

        // Add passcode form submission
        document.getElementById('add-passcode-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('new-friend-name').value.trim();
            const code = document.getElementById('new-friend-code').value.trim();
            if (name && code) {
                addPasscode(name, code);
                this.showToast(`Kód elmentve: ${name} (${code})`, 'success');
                document.getElementById('add-passcode-form').reset();
                this.renderPasscodeList();
                // Sync to Drive so friends on other devices can log in
                await this.uploadPasscodesToDrive();
            }
        });

        // Close modals
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                btn.closest('.modal-overlay').classList.remove('active');
            });
        });

        // Close modal on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.classList.remove('active');
                }
            });
        });

        // Add form submission
        document.getElementById('add-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAddTorrent();
        });

        // Torrent card click → detail modal
        document.getElementById('torrent-grid')?.addEventListener('click', (e) => {
            const card = e.target.closest('.torrent-card');
            if (card && !e.target.closest('.btn') && !e.target.closest('.card-delete-btn')) {
                const torrentId = card.dataset.id;
                this.showDetailModal(torrentId);
            }
        });

        // Cover image drag & drop
        const dropZone = document.getElementById('cover-drop-zone');
        if (dropZone) {
            dropZone.addEventListener('dragover', (e) => {
                e.preventDefault();
                dropZone.classList.add('drag-over');
            });
            dropZone.addEventListener('dragleave', () => {
                dropZone.classList.remove('drag-over');
            });
            dropZone.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZone.classList.remove('drag-over');
                const file = e.dataTransfer.files[0];
                if (file && file.type.startsWith('image/')) {
                    document.getElementById('cover-input').files = e.dataTransfer.files;
                    dropZone.querySelector('.drop-zone-text').textContent = file.name;
                }
            });
            dropZone.addEventListener('click', () => {
                document.getElementById('cover-input').click();
            });
            document.getElementById('cover-input')?.addEventListener('change', (e) => {
                if (e.target.files[0]) {
                    dropZone.querySelector('.drop-zone-text').textContent = e.target.files[0].name;
                }
            });
        }

        // Sidebar toggle (mobile)
        document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('open');
        });

        // Refresh button
        document.getElementById('refresh-btn')?.addEventListener('click', async () => {
            driveAPI.clearCache();
            await this.loadTorrents();
            this.showToast('Adatok frissítve!');
        });
    }

    renderPasscodeList() {
        const listEl = document.getElementById('passcode-list');
        if (!listEl) return;
        const passcodes = getPasscodes();
        if (passcodes.length === 0) {
            listEl.innerHTML = '<p style="color: var(--text-muted); font-size: 13px;">Még nincs mentett kód.</p>';
            return;
        }
        listEl.innerHTML = passcodes.map(p => `
            <div class="passcode-item" style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05); padding: 10px 14px; border-radius: 10px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.08);">
                <div>
                    <strong style="color: var(--text-primary); font-size: 14px;">${this.escapeHtml(p.name)}</strong>
                    <span style="display: inline-block; margin-left: 8px; background: rgba(0,240,255,0.15); color: var(--accent-cyan); padding: 2px 8px; border-radius: 6px; font-family: monospace; font-size: 13px; font-weight: 600;">${this.escapeHtml(p.code)}</span>
                </div>
                <button type="button" onclick="app.handleDeletePasscode('${p.id}')" class="btn-icon" style="color: #ef4444; width: 32px; height: 32px;" title="Kód törlése">🗑️</button>
            </div>
        `).join('');
    }

    async handleDeletePasscode(id) {
        deletePasscode(id);
        this.showToast('Kód törölve!', 'info');
        this.renderPasscodeList();
        // Sync to Drive so friends on other devices can log in
        await this.uploadPasscodesToDrive();
    }

    // Upload passcodes.json to Google Drive (admin only, uses OAuth)
    // Stores passcode JSON in file description (readable by API key) AND file content
    async uploadPasscodesToDrive() {
        if (!isAdmin()) return;
        try {
            const passcodes = getPasscodes();
            const content = JSON.stringify(passcodes);

            const token = await driveAPI.getAccessToken();

            // Check if passcodes.json already exists
            const searchUrl = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_ROOT_FOLDER_ID}'+in+parents+and+name='passcodes.json'+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id)`;
            const searchRes = await fetch(searchUrl);
            const searchData = await searchRes.json();
            const existingFiles = searchData.files || [];

            if (existingFiles.length > 0) {
                // Update existing file content AND description
                const fileId = existingFiles[0].id;
                // Update description (metadata) — this is what friends read via API key
                await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ description: content })
                });
            } else {
                // Create new file with description
                await driveAPI.uploadTextFile(content, CONFIG.DRIVE_ROOT_FOLDER_ID, 'passcodes.json', content);
            }
            this.showToast('Kódok szinkronizálva a Drive-ra!', 'success');
        } catch (e) {
            console.error('Failed to upload passcodes to Drive:', e);
            this.showToast('Drive szinkronizálás sikertelen', 'error');
        }
    }

    // Open magnet link in desktop torrent app (Deluge, uTorrent, qBittorrent, etc.)
    async openMagnet(torrentIdOrLink) {
        if (!torrentIdOrLink) return;

        let magnetUri = '';
        let torrent = null;

        if (typeof torrentIdOrLink === 'string' && torrentIdOrLink.startsWith('magnet:?')) {
            magnetUri = torrentIdOrLink.trim();
        } else {
            torrent = this.torrents.find(t => t.id === torrentIdOrLink);
            if (torrent) {
                magnetUri = torrent.magnetLink || '';
            }
        }

        // On-demand fetch via Google Drive API Key if not pre-loaded yet
        if (!magnetUri && torrent && torrent.magnetFileId) {
            this.showToast('Magnet link beolvasása...', 'info');
            try {
                const text = await driveAPI.readTextFile(torrent.magnetFileId, torrent.title);
                if (text && text.includes('magnet:?')) {
                    const match = text.match(/magnet:\?xt=urn:[^\s"']+/i);
                    magnetUri = match ? match[0] : text.trim();
                    torrent.magnetLink = magnetUri;
                }
            } catch (e) {
                console.error('Failed to fetch magnet:', e);
            }
        }

        if (magnetUri && magnetUri.startsWith('magnet:?')) {
            if (!magnetUri.toLowerCase().includes('&dn=') && torrent && torrent.title) {
                magnetUri += `&dn=${encodeURIComponent(torrent.title)}`;
            }
            // Trigger OS native protocol prompt ("Open deluge.exe?")
            window.location.href = magnetUri;
        } else {
            this.showToast('Nem található érvényes magnet link!', 'error');
        }
    }

    // Download torrent file
    downloadTorrent(fileId, fileName) {
        const url = `https://drive.google.com/uc?id=${fileId}&export=download`;
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // Show torrent detail modal
    showDetailModal(torrentId) {
        const torrent = this.torrents.find(t => t.id === torrentId);
        if (!torrent) return;

        const categoryInfo = CONFIG.CATEGORIES[torrent.category] || { emoji: '📁', color: '#888' };
        const dateStr = torrent.createdTime 
            ? new Date(torrent.createdTime).toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' })
            : '';

        const modal = document.getElementById('detail-modal');
        const coverEl = modal.querySelector('.detail-cover');
        coverEl.innerHTML = torrent.coverUrl ? `<img src="${torrent.coverUrl}" referrerpolicy="no-referrer" class="card-cover-img" alt="${this.escapeHtml(torrent.title)}">` : '';
        coverEl.classList.toggle('no-cover', !torrent.coverUrl);
        modal.querySelector('.detail-title').textContent = torrent.title;
        modal.querySelector('.detail-category').innerHTML = `<span style="color: ${categoryInfo.color}">${categoryInfo.emoji} ${torrent.category}</span>`;
        modal.querySelector('.detail-date').textContent = dateStr;
        modal.querySelector('.detail-description').textContent = torrent.description || 'Nincs leírás.';
        
        const actionsEl = modal.querySelector('.detail-actions');
        actionsEl.innerHTML = '';
        if (torrent.magnetLink || torrent.magnetFileId) {
            actionsEl.innerHTML += `<button class="btn btn-magnet btn-lg" onclick="app.openMagnet('${torrent.id}')">🧲 Megnyitás Deluge-al</button>`;
        }
        if (torrent.torrentFileId) {
            actionsEl.innerHTML += `<button class="btn btn-torrent btn-lg" onclick="app.downloadTorrent('${torrent.torrentFileId}', '${this.escapeHtml(torrent.torrentFileName)}')">📥 Torrent Fájl Letöltése</button>`;
        }

        modal.classList.add('active');
    }

    // Handle add torrent form
    async handleAddTorrent() {
        const title = document.getElementById('add-title').value.trim();
        const category = document.getElementById('add-category').value;
        const magnetLink = document.getElementById('add-magnet').value.trim();
        const coverFile = document.getElementById('cover-input').files[0];
        const torrentFile = document.getElementById('torrent-input').files[0];
        const description = document.getElementById('add-description').value.trim();

        if (!title || !category) {
            this.showToast('A cím és kategória kötelező!', 'error');
            return;
        }

        if (!magnetLink && !torrentFile) {
            this.showToast('Magnet link vagy torrent fájl szükséges!', 'error');
            return;
        }

        const submitBtn = document.querySelector('#add-form .btn-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Feltöltés...';

        try {
            await driveAPI.addTorrent({ title, category, coverFile, magnetLink, torrentFile, description });
            this.showToast('Sikeresen hozzáadva!', 'success');
            document.getElementById('add-modal').classList.remove('active');
            document.getElementById('add-form').reset();
            document.querySelector('.drop-zone-text').textContent = 'Húzd ide a borítóképet vagy kattints';
            await this.loadTorrents();
        } catch (error) {
            console.error('Add torrent error:', error);
            this.showToast(error.message || 'Hiba történt a feltöltéskor!', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Hozzáadás';
        }
    }

    // Confirm delete
    async confirmDelete(torrentId, title) {
        if (confirm(`Biztosan törlöd: "${title}"?`)) {
            try {
                await driveAPI.deleteTorrent(torrentId);
                this.showToast('Törölve!', 'success');
                await this.loadTorrents();
            } catch (error) {
                console.error('Delete error:', error);
                this.showToast('Hiba a törléskor!', 'error');
            }
        }
    }

    // Toast notification
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container') || (() => {
            const el = document.createElement('div');
            el.id = 'toast-container';
            document.body.appendChild(el);
            return el;
        })();

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-exit');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    showLoading(show) {
        const spinner = document.getElementById('loading-spinner');
        if (spinner) spinner.style.display = show ? 'flex' : 'none';
    }

    showError(message) {
        const grid = document.getElementById('torrent-grid');
        grid.innerHTML = `
            <div class="error-state">
                <div class="error-state-icon">⚠️</div>
                <h3>Hiba</h3>
                <p>${message}</p>
                <button class="btn btn-magnet" onclick="app.loadTorrents()">Újrapróbálás</button>
            </div>
        `;
    }

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, (m) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    }
}

// Initialize app
const app = new App();
document.addEventListener('DOMContentLoaded', () => app.init());
