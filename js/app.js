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
            const dateStr = torrent.createdTime 
                ? new Date(torrent.createdTime).toLocaleDateString('hu-HU')
                : '';

            return `
                <div class="torrent-card ll-frame" style="--card-index: ${index}" data-id="${torrent.id}">
                    <div class="ll-frame-chrome">
                        <span class="chrome-dots"><i></i><i></i><i></i></span>
                        <span class="chrome-title">${torrent.category.toUpperCase()} // ${dateStr || 'DENJI-T'}</span>
                        ${isAdmin() ? `
                            <button class="card-edit-btn" onclick="event.stopPropagation(); app.openEditModal('${torrent.id}')" title="Szerkesztés">✏️</button>
                            <button class="card-delete-btn" onclick="event.stopPropagation(); app.confirmDelete('${torrent.id}', '${this.escapeHtml(torrent.title)}')" title="Törlés">🗑️</button>
                        ` : ''}
                    </div>
                    <div class="card-cover">
                        ${torrent.coverUrl ? `<img src="${torrent.coverUrl}" referrerpolicy="no-referrer" class="card-cover-img" alt="${this.escapeHtml(torrent.title)}">` : `<div class="card-cover-placeholder">${categoryInfo.emoji}</div>`}
                    </div>
                    <div class="card-body">
                        <h3 class="card-title" title="${this.escapeHtml(torrent.title)}">${torrent.title}</h3>
                        <div class="card-actions">
                            ${(torrent.streamUrl || (torrent.episodes && torrent.episodes.length) || (torrent.seasons && torrent.seasons.length)) ? `<button class="btn btn-stream" onclick="event.stopPropagation(); app.showDetailModal('${torrent.id}')">▶ Lejátszás</button>` : ''}
                            ${torrent.downloadUrl ? `<button class="btn btn-download" onclick="event.stopPropagation(); window.open('${torrent.downloadUrl}', '_blank')">↓ Letöltés</button>` : ''}
                            ${(torrent.magnetLink || torrent.magnetFileId) ? `<button class="btn btn-magnet" onclick="event.stopPropagation(); app.openMagnet('${torrent.id}')">🧲 Magnet</button>` : ''}
                            ${torrent.torrentFileId ? `<button class="btn btn-torrent" onclick="event.stopPropagation(); app.downloadTorrent('${torrent.torrentFileId}', '${this.escapeHtml(torrent.torrentFileName)}')">📥 Torrent</button>` : ''}
                        </div>
                    </div>
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
        document.getElementById('add-torrent-fab')?.addEventListener('click', () => {
            this.resetAddForm();
            document.getElementById('add-modal').classList.add('active');
            this.updateStreamFormByCategory();
        });

        // Category change → film vs series stream UI
        document.getElementById('add-category')?.addEventListener('change', () => {
            this.updateStreamFormByCategory();
        });

        // Add season button
        document.getElementById('add-season-btn')?.addEventListener('click', () => {
            this.addSeasonBlock();
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

        const closeAllModals = () => {
            document.querySelectorAll('.modal-overlay').forEach(modal => modal.classList.remove('active'));
            this.clearCinemaPlayers();
            const streamIframe = document.getElementById('stream-player-iframe');
            if (streamIframe) streamIframe.src = '';
        };

        // Close modals on X button click OR backdrop overlay click
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', closeAllModals);
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    closeAllModals();
                }
            });
        });

        // Detail modal navigation tabs
        document.addEventListener('click', (e) => {
            const tabBtn = e.target.closest('.detail-nav-btn');
            if (tabBtn) {
                const targetTab = tabBtn.dataset.tab;
                document.querySelectorAll('.detail-nav-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.detail-tab-content').forEach(c => c.classList.remove('active'));
                tabBtn.classList.add('active');
                document.getElementById(`tab-${targetTab}`)?.classList.add('active');
            }
        });

        // Add form submission
        document.getElementById('add-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAddTorrent();
        });

        // Torrent card click → detail modal
        document.getElementById('torrent-grid')?.addEventListener('click', (e) => {
            const card = e.target.closest('.torrent-card');
            if (card && !e.target.closest('.btn') && !e.target.closest('.card-delete-btn') && !e.target.closest('.card-edit-btn')) {
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
            <div class="passcode-item" style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-input); padding: 10px 14px; border-radius: 10px; margin-bottom: 8px; border: 1px solid var(--border-subtle);">
                <div>
                    <strong style="color: var(--text); font-size: 14px;">${this.escapeHtml(p.name)}</strong>
                    <span style="display: inline-block; margin-left: 8px; background: var(--accent-soft); color: var(--accent); padding: 2px 8px; border-radius: 6px; font-family: monospace; font-size: 13px; font-weight: 600;">${this.escapeHtml(p.code)}</span>
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

    clearCinemaPlayers() {
        const iframe = document.getElementById('cinema-player-iframe');
        const videoEl = document.getElementById('cinema-player-video');
        if (iframe) {
            iframe.src = '';
            iframe.style.display = 'none';
        }
        if (videoEl) {
            videoEl.pause();
            videoEl.removeAttribute('src');
            videoEl.load();
            videoEl.style.display = 'none';
        }
    }

    // Play Streamtape / YouTube in embed iframe
    playEmbed(url) {
        const iframe = document.getElementById('cinema-player-iframe');
        const videoEl = document.getElementById('cinema-player-video');
        const placeholder = document.getElementById('cinema-player-placeholder');
        if (videoEl) {
            videoEl.pause();
            videoEl.removeAttribute('src');
            videoEl.style.display = 'none';
        }
        if (iframe) {
            let embed = url || '';
            if (embed.includes('streamtape.com/v/')) embed = embed.replace('streamtape.com/v/', 'streamtape.com/e/');
            iframe.src = embed;
            iframe.style.display = 'block';
        }
        if (placeholder) placeholder.style.display = 'none';
    }

    // Show torrent detail modal (Carousel Player + Blueprint Layout)
    showDetailModal(torrentId) {
        const torrent = this.torrents.find(t => t.id === torrentId);
        if (!torrent) return;
        this.currentDetailId = torrentId;

        const categoryInfo = CONFIG.CATEGORIES[torrent.category] || { emoji: '📁', color: '#888' };
        const dateStr = torrent.createdTime 
            ? new Date(torrent.createdTime).toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' })
            : '';

        const modal = document.getElementById('detail-modal');
        const iframe = document.getElementById('cinema-player-iframe');
        const placeholder = document.getElementById('cinema-player-placeholder');
        const coverEl = placeholder ? placeholder.querySelector('.detail-cover') : null;
        const tabsEl = document.getElementById('cinema-server-tabs');

        const posterEl = modal.querySelector('.blueprint-poster-col .detail-cover');
        if (posterEl) {
            posterEl.innerHTML = torrent.coverUrl ? `<img src="${torrent.coverUrl}" referrerpolicy="no-referrer" class="card-cover-img" alt="${this.escapeHtml(torrent.title)}">` : `<div class="card-cover-placeholder">${categoryInfo.emoji}</div>`;
            posterEl.classList.toggle('no-cover', !torrent.coverUrl);
        }

        modal.querySelector('.detail-title').textContent = torrent.title;
        modal.querySelector('.detail-category').innerHTML = `<span style="color: ${categoryInfo.color}">${categoryInfo.emoji} ${torrent.category}</span>`;
        modal.querySelector('.detail-date').textContent = dateStr;

        // Description
        const descContainer = modal.querySelector('.detail-description');
        if (descContainer) {
            if (torrent.description && torrent.description.trim()) {
                descContainer.textContent = torrent.description.trim();
            } else if (torrent.descriptionFileId) {
                descContainer.textContent = 'Leírás betöltése...';
                driveAPI.readTextFile(torrent.descriptionFileId, torrent.title).then(text => {
                    if (text && text.trim()) {
                        torrent.description = text.trim();
                        if (this.currentDetailId === torrent.id) {
                            descContainer.textContent = text.trim();
                        }
                    } else if (this.currentDetailId === torrent.id) {
                        descContainer.textContent = 'Nincs leírás megadva.';
                    }
                }).catch(() => {
                    if (this.currentDetailId === torrent.id) descContainer.textContent = 'Nincs leírás megadva.';
                });
            } else {
                descContainer.textContent = 'Nincs leírás megadva.';
            }
        }

        // Build Media Items List for Top Stage & Carousel
        this.currentMediaList = [];
        this.currentEpisodeIndex = 0;
        this.currentSeasonIndex = 0;

        // Normalize: seasons preferred, fallback to flat episodes as season 1
        if ((!torrent.seasons || !torrent.seasons.length) && torrent.episodes && torrent.episodes.length) {
            torrent.seasons = [{ season: 1, episodes: torrent.episodes }];
        }

        const seriesSelector = document.getElementById('series-episode-selector');
        if (torrent.seasons && torrent.seasons.length > 0) {
            const firstSeason = torrent.seasons[0];
            const first = firstSeason.episodes && firstSeason.episodes[0];
            if (first) {
                let clean = first.url;
                if (clean.includes('streamtape.com/v/')) clean = clean.replace('streamtape.com/v/', 'streamtape.com/e/');
                this.currentMediaList.push({ type: 'iframe', label: `S${firstSeason.season}E${first.ep}`, url: clean });
            }
            if (seriesSelector) {
                seriesSelector.style.display = 'block';
                this.renderSeriesPlayer(torrent);
            }
        } else {
            if (seriesSelector) seriesSelector.style.display = 'none';
            if (torrent.streamUrl) {
                let cleanStream = torrent.streamUrl;
                if (cleanStream.includes('streamtape.com/v/')) cleanStream = cleanStream.replace('streamtape.com/v/', 'streamtape.com/e/');
                this.currentMediaList.push({ type: 'iframe', label: '📺 Streamtape', url: cleanStream });
            }
        }

        if (torrent.trailers && torrent.trailers.length > 0) {
            torrent.trailers.forEach((tUrl, idx) => {
                const ytid = this.extractYouTubeId(tUrl);
                if (ytid) {
                    this.currentMediaList.push({ type: 'iframe', label: `🎥 Trailer #${idx + 1}`, url: `https://www.youtube.com/embed/${ytid}` });
                }
            });
        }
        this.currentMediaIndex = 0;

        const updateStage = () => {
            const prevBtn = document.getElementById('cinema-prev-btn');
            const nextBtn = document.getElementById('cinema-next-btn');
            const videoEl = document.getElementById('cinema-player-video');

            if (!this.currentMediaList || this.currentMediaList.length === 0) {
                this.clearCinemaPlayers();
                if (placeholder) {
                    placeholder.style.display = 'block';
                    placeholder.innerHTML = torrent.coverUrl ? `
                        <img src="${torrent.coverUrl}" referrerpolicy="no-referrer" style="width:100%; height:100%; object-fit:cover; display:block;" alt="${this.escapeHtml(torrent.title)}">
                    ` : `<div class="card-cover-placeholder" style="display:flex;align-items:center;justify-content:center;height:100%;font-size:48px;opacity:0.3;color:#fff;">${categoryInfo.emoji}</div>`;
                }
                if (tabsEl) tabsEl.style.display = 'none';
                if (prevBtn) prevBtn.style.display = 'none';
                if (nextBtn) nextBtn.style.display = 'none';
                return;
            } else {
                if (tabsEl) tabsEl.style.display = 'flex';
                if (prevBtn) prevBtn.style.display = 'flex';
                if (nextBtn) nextBtn.style.display = 'flex';
            }

            const activeItem = this.currentMediaList[this.currentMediaIndex];
            if (placeholder) placeholder.style.display = 'none';

            if (activeItem && activeItem.url) {
                this.playEmbed(activeItem.url);
            } else {
                this.clearCinemaPlayers();
                if (placeholder) {
                    placeholder.style.display = 'block';
                    placeholder.innerHTML = torrent.coverUrl ? `
                        <img src="${torrent.coverUrl}" referrerpolicy="no-referrer" style="width:100%; height:100%; object-fit:cover; display:block;" alt="${this.escapeHtml(torrent.title)}">
                    ` : '';
                }
            }

            if (tabsEl) {
                tabsEl.querySelectorAll('.cinema-tab-btn').forEach((btn, idx) => {
                    btn.classList.toggle('active', idx === this.currentMediaIndex);
                });
            }
        };

        // Render Media Switcher Tabs below Stage
        if (tabsEl) {
            if (this.currentMediaList.length > 0) {
                tabsEl.innerHTML = this.currentMediaList.map((m, idx) => `
                    <button class="cinema-tab-btn ${idx === 0 ? 'active' : ''}" data-index="${idx}">
                        ${m.label}
                    </button>
                `).join('');

                tabsEl.querySelectorAll('.cinema-tab-btn').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        const target = e.target.closest('.cinema-tab-btn');
                        if (target) {
                            this.currentMediaIndex = parseInt(target.dataset.index, 10);
                            updateStage();
                        }
                    });
                });
            } else {
                tabsEl.innerHTML = '';
            }
        }

        // Arrow Buttons
        const prevBtn = document.getElementById('cinema-prev-btn');
        const nextBtn = document.getElementById('cinema-next-btn');

        if (prevBtn) {
            prevBtn.onclick = (e) => {
                e.stopPropagation();
                if (this.currentMediaList.length > 0) {
                    this.currentMediaIndex = (this.currentMediaIndex - 1 + this.currentMediaList.length) % this.currentMediaList.length;
                    updateStage();
                }
            };
        }

        if (nextBtn) {
            nextBtn.onclick = (e) => {
                e.stopPropagation();
                if (this.currentMediaList.length > 0) {
                    this.currentMediaIndex = (this.currentMediaIndex + 1) % this.currentMediaList.length;
                    updateStage();
                }
            };
        }

        updateStage();

        // Render Bottom Download Options Grid (no Online Lejátszás — already playing above)
        const actionsEl = modal.querySelector('.detail-actions');
        if (actionsEl) {
            actionsEl.innerHTML = '';
            if (torrent.downloadUrl) {
                actionsEl.innerHTML += `<button class="btn btn-download btn-lg" onclick="window.open('${torrent.downloadUrl}', '_blank')">⚡ Közvetlen Letöltés</button>`;
            }
            if (torrent.magnetLink || torrent.magnetFileId) {
                actionsEl.innerHTML += `<button class="btn btn-magnet btn-lg" onclick="app.openMagnet('${torrent.id}')">🧲 Megnyitás Deluge-al</button>`;
            }
            if (torrent.torrentFileId) {
                actionsEl.innerHTML += `<button class="btn btn-torrent btn-lg" onclick="app.downloadTorrent('${torrent.torrentFileId}', '${this.escapeHtml(torrent.torrentFileName)}')">📥 Torrent Fájl Letöltése</button>`;
            }
            // Hide the whole section if nothing to show
            const section = modal.querySelector('.cinema-actions-section');
            if (section) section.style.display = actionsEl.innerHTML.trim() ? '' : 'none';
        }

        modal.classList.add('active');
    }

    playStreamFromDetail(torrentId) {
        const torrent = this.torrents.find(t => t.id === torrentId);
        if (!torrent) return;
        let cleanStream = '';
        if (torrent.seasons && torrent.seasons.length) {
            const s = torrent.seasons[this.currentSeasonIndex || 0] || torrent.seasons[0];
            const ep = s?.episodes?.[this.currentEpisodeIndex || 0] || s?.episodes?.[0];
            if (ep) cleanStream = ep.url;
        } else if (torrent.episodes && torrent.episodes.length) {
            const ep = torrent.episodes[this.currentEpisodeIndex || 0] || torrent.episodes[0];
            if (ep) cleanStream = ep.url;
        } else if (torrent.streamUrl) {
            cleanStream = torrent.streamUrl;
        }
        if (!cleanStream) return;
        if (cleanStream.includes('streamtape.com/v/')) cleanStream = cleanStream.replace('streamtape.com/v/', 'streamtape.com/e/');
        const iframe = document.getElementById('cinema-player-iframe');
        const placeholder = document.getElementById('cinema-player-placeholder');
        if (iframe && placeholder) {
            iframe.src = cleanStream;
            iframe.style.display = 'block';
            placeholder.style.display = 'none';
        }
    }

    renderSeriesPlayer(torrent) {
        const seasonTabs = document.getElementById('series-season-tabs');
        const list = document.getElementById('series-episode-list');
        const prevBtn = document.getElementById('series-ep-prev');
        const nextBtn = document.getElementById('series-ep-next');
        if (!list || !torrent.seasons) return;

        const playEp = (sIdx, eIdx) => {
            const season = torrent.seasons[sIdx];
            const ep = season?.episodes?.[eIdx];
            if (!ep) return;
            this.currentSeasonIndex = sIdx;
            this.currentEpisodeIndex = eIdx;

            let clean = ep.url;
            if (clean.includes('streamtape.com/v/')) clean = clean.replace('streamtape.com/v/', 'streamtape.com/e/');

            const trailers = this.currentMediaList.filter(m => m.label && m.label.startsWith('🎥'));
            this.currentMediaList = [{ type: 'iframe', label: `S${season.season}E${ep.ep}`, url: clean }, ...trailers];
            this.currentMediaIndex = 0;

            const placeholder = document.getElementById('cinema-player-placeholder');
            this.playEmbed(clean);
            if (placeholder) placeholder.style.display = 'none';

            list.querySelectorAll('.series-episode-btn').forEach((b, i) => b.classList.toggle('active', i === eIdx));

            const tabsEl = document.getElementById('cinema-server-tabs');
            if (tabsEl) {
                tabsEl.innerHTML = this.currentMediaList.map((m, i) => `
                    <button class="cinema-tab-btn ${i === 0 ? 'active' : ''}" data-index="${i}">${m.label}</button>
                `).join('');
                tabsEl.querySelectorAll('.cinema-tab-btn').forEach(tbtn => {
                    tbtn.addEventListener('click', (e) => {
                        const t = e.target.closest('.cinema-tab-btn');
                        if (!t) return;
                        this.currentMediaIndex = parseInt(t.dataset.index, 10);
                        const item = this.currentMediaList[this.currentMediaIndex];
                        if (item && iframe) {
                            iframe.src = item.url;
                            iframe.style.display = 'block';
                            if (placeholder) placeholder.style.display = 'none';
                        }
                        tabsEl.querySelectorAll('.cinema-tab-btn').forEach((b, i) => b.classList.toggle('active', i === this.currentMediaIndex));
                    });
                });
            }
        };

        const renderEps = (sIdx) => {
            const season = torrent.seasons[sIdx];
            if (!season) return;
            list.innerHTML = (season.episodes || []).map((ep, idx) => `
                <button class="series-episode-btn ${sIdx === this.currentSeasonIndex && idx === this.currentEpisodeIndex ? 'active' : ''}" data-idx="${idx}">
                    ${ep.ep}. rész
                </button>
            `).join('');
            list.querySelectorAll('.series-episode-btn').forEach(btn => {
                btn.addEventListener('click', () => playEp(sIdx, parseInt(btn.dataset.idx, 10)));
            });
            list.scrollLeft = 0;
        };

        // Season tabs (hide if only 1 season)
        if (seasonTabs) {
            if (torrent.seasons.length > 1) {
                seasonTabs.style.display = 'flex';
                seasonTabs.innerHTML = torrent.seasons.map((s, i) => `
                    <button class="series-season-btn ${i === 0 ? 'active' : ''}" data-sidx="${i}">${s.season}. évad</button>
                `).join('');
                seasonTabs.querySelectorAll('.series-season-btn').forEach(btn => {
                    btn.addEventListener('click', () => {
                        const sIdx = parseInt(btn.dataset.sidx, 10);
                        seasonTabs.querySelectorAll('.series-season-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        this.currentSeasonIndex = sIdx;
                        this.currentEpisodeIndex = 0;
                        renderEps(sIdx);
                        playEp(sIdx, 0);
                    });
                });
            } else {
                seasonTabs.style.display = 'none';
                seasonTabs.innerHTML = '';
            }
        }

        // Horizontal arrows
        if (prevBtn) prevBtn.onclick = () => { list.scrollBy({ left: -200, behavior: 'smooth' }); };
        if (nextBtn) nextBtn.onclick = () => { list.scrollBy({ left: 200, behavior: 'smooth' }); };

        // Drag-to-scroll (no visible scrollbar)
        let isDown = false, startX = 0, scrollLeft = 0;
        list.onmousedown = (e) => {
            isDown = true;
            startX = e.pageX - list.offsetLeft;
            scrollLeft = list.scrollLeft;
        };
        list.onmouseleave = () => { isDown = false; };
        list.onmouseup = () => { isDown = false; };
        list.onmousemove = (e) => {
            if (!isDown) return;
            e.preventDefault();
            const x = e.pageX - list.offsetLeft;
            list.scrollLeft = scrollLeft - (x - startX);
        };

        renderEps(0);
    }

    // Extract YouTube video ID from various URL formats
    extractYouTubeId(url) {
        if (!url) return null;
        const patterns = [
            /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
            /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
            /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
            /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    // Open Streamtape video player modal
    openStreamModal(torrentIdOrUrl) {
        let streamUrl = '';
        let title = '▶️ Online Lejátszás';

        if (typeof torrentIdOrUrl === 'string' && torrentIdOrUrl.startsWith('http')) {
            streamUrl = torrentIdOrUrl;
        } else {
            const torrent = this.torrents.find(t => t.id === torrentIdOrUrl);
            if (torrent) {
                title = `▶️ ${torrent.title}`;
                // Series → open detail modal (episode picker)
                if ((torrent.seasons && torrent.seasons.length) || (torrent.episodes && torrent.episodes.length)) {
                    this.showDetailModal(torrent.id);
                    return;
                }
                if (torrent.streamUrl) {
                    streamUrl = torrent.streamUrl;
                }
            }
        }

        if (!streamUrl) {
            this.showToast('Nincs elérhető stream link!', 'error');
            return;
        }

        if (streamUrl.includes('streamtape.com/v/')) {
            streamUrl = streamUrl.replace('streamtape.com/v/', 'streamtape.com/e/');
        }

        const modal = document.getElementById('stream-modal');
        const iframe = document.getElementById('stream-player-iframe');
        const titleEl = document.getElementById('stream-modal-title');

        if (titleEl) titleEl.textContent = title;
        if (iframe) iframe.src = streamUrl;
        modal.classList.add('active');
    }

    closeStreamModal() {
        const modal = document.getElementById('stream-modal');
        const iframe = document.getElementById('stream-player-iframe');
        if (iframe) iframe.src = '';
        if (modal) modal.classList.remove('active');
    }

    // Toggle film single-stream vs series seasons form
    updateStreamFormByCategory() {
        const category = document.getElementById('add-category')?.value;
        const filmGroup = document.getElementById('film-stream-group');
        const seriesGroup = document.getElementById('series-stream-group');
        if (!filmGroup || !seriesGroup) return;

        if (category === 'Sorozat') {
            filmGroup.style.display = 'none';
            seriesGroup.style.display = 'block';
            const editor = document.getElementById('seasons-editor');
            if (editor && editor.children.length === 0) {
                this.addSeasonBlock();
            }
        } else {
            filmGroup.style.display = 'block';
            seriesGroup.style.display = 'none';
        }
    }

    addSeasonBlock(episodes = null) {
        const editor = document.getElementById('seasons-editor');
        if (!editor) return;
        const seasonNum = editor.children.length + 1;
        const block = document.createElement('div');
        block.className = 'season-block';
        block.innerHTML = `
            <div class="season-block-header">
                <span class="season-label">${seasonNum}. évad</span>
                <button type="button" class="btn-remove-season" title="Évad törlése">✕</button>
            </div>
            <div class="episodes-list-editor"></div>
            <button type="button" class="btn-add-ep-in-season">+ Rész hozzáadása</button>
        `;
        editor.appendChild(block);

        const list = block.querySelector('.episodes-list-editor');
        if (episodes && episodes.length) {
            episodes.forEach(ep => this.addEpisodeEditRow(list, ep.url));
        } else {
            this.addEpisodeEditRow(list);
        }

        block.querySelector('.btn-remove-season').addEventListener('click', () => {
            block.remove();
            this.renumberSeasonBlocks();
        });
        block.querySelector('.btn-add-ep-in-season').addEventListener('click', () => {
            this.addEpisodeEditRow(list);
        });
    }

    renumberSeasonBlocks() {
        const editor = document.getElementById('seasons-editor');
        if (!editor) return;
        editor.querySelectorAll('.season-block').forEach((block, i) => {
            const label = block.querySelector('.season-label');
            if (label) label.textContent = `${i + 1}. évad`;
        });
    }

    addEpisodeEditRow(listEl, url = '') {
        if (!listEl) return;
        const num = listEl.children.length + 1;
        const row = document.createElement('div');
        row.className = 'episode-edit-row';
        row.innerHTML = `
            <span class="ep-num">${num}</span>
            <input type="text" class="ep-url" placeholder="https://streamtape.com/v/..." value="${this.escapeHtml(url)}">
            <button type="button" class="btn-remove-ep" title="Törlés">✕</button>
        `;
        listEl.appendChild(row);
        row.querySelector('.btn-remove-ep').addEventListener('click', () => {
            row.remove();
            listEl.querySelectorAll('.episode-edit-row').forEach((r, i) => {
                const n = r.querySelector('.ep-num');
                if (n) n.textContent = i + 1;
            });
        });
    }

    collectSeasonsFromForm() {
        const editor = document.getElementById('seasons-editor');
        if (!editor) return [];
        const seasons = [];
        editor.querySelectorAll('.season-block').forEach((block, sIdx) => {
            const episodes = [];
            block.querySelectorAll('.episode-edit-row').forEach((row, eIdx) => {
                const url = (row.querySelector('.ep-url')?.value || '').trim();
                if (url) episodes.push({ ep: eIdx + 1, url });
            });
            if (episodes.length) {
                seasons.push({ season: sIdx + 1, episodes });
            }
        });
        return seasons;
    }

    resetAddForm() {
        document.getElementById('add-form')?.reset();
        document.getElementById('edit-torrent-id').value = '';
        document.getElementById('add-modal-title').textContent = 'Új Torrent Hozzáadása';
        document.getElementById('add-submit-text').textContent = 'Torrent Feltöltése';
        const editor = document.getElementById('seasons-editor');
        if (editor) editor.innerHTML = '';
        const dropText = document.querySelector('.drop-zone-text');
        if (dropText) dropText.textContent = 'Húzd ide a borítóképet vagy kattints';
        this.updateStreamFormByCategory();
    }

    openEditModal(torrentId) {
        const torrent = this.torrents.find(t => t.id === torrentId);
        if (!torrent) return;

        this.resetAddForm();
        document.getElementById('edit-torrent-id').value = torrentId;
        document.getElementById('add-modal-title').textContent = 'Szerkesztés: ' + torrent.title;
        document.getElementById('add-submit-text').textContent = 'Mentés';

        document.getElementById('add-title').value = torrent.title || '';
        document.getElementById('add-category').value = torrent.category || '';
        document.getElementById('add-magnet').value = torrent.magnetLink || '';
        document.getElementById('add-download').value = torrent.downloadUrl || '';
        document.getElementById('add-description').value = torrent.description || '';
        if (torrent.trailers && torrent.trailers.length) {
            document.getElementById('add-trailers').value = torrent.trailers.join('\n');
        }

        this.updateStreamFormByCategory();

        if (torrent.category === 'Sorozat') {
            const editor = document.getElementById('seasons-editor');
            if (editor) editor.innerHTML = '';
            if (torrent.seasons && torrent.seasons.length) {
                torrent.seasons.forEach(s => this.addSeasonBlock(s.episodes));
            } else if (torrent.episodes && torrent.episodes.length) {
                // Legacy flat episodes → one season
                this.addSeasonBlock(torrent.episodes);
            } else {
                this.addSeasonBlock();
            }
        } else if (torrent.streamUrl) {
            document.getElementById('add-stream').value = torrent.streamUrl;
        }

        document.getElementById('add-modal').classList.add('active');
    }

    // Handle add / edit torrent form
    async handleAddTorrent() {
        const editId = document.getElementById('edit-torrent-id')?.value || '';
        const title = document.getElementById('add-title').value.trim();
        const category = document.getElementById('add-category').value;
        const magnetLink = document.getElementById('add-magnet').value.trim();
        const streamUrl = document.getElementById('add-stream') ? document.getElementById('add-stream').value.trim() : '';
        const downloadUrl = document.getElementById('add-download') ? document.getElementById('add-download').value.trim() : '';
        const trailersRaw = document.getElementById('add-trailers') ? document.getElementById('add-trailers').value.trim() : '';
        const trailers = trailersRaw ? trailersRaw.split('\n').map(u => u.trim()).filter(u => u) : [];
        const coverFile = document.getElementById('cover-input').files[0];
        const torrentFile = document.getElementById('torrent-input').files[0];
        const description = document.getElementById('add-description').value.trim();
        let seasons = null;
        if (category === 'Sorozat') {
            seasons = this.collectSeasonsFromForm();
        }

        if (!title || !category) {
            this.showToast('A cím és kategória kötelező!', 'error');
            return;
        }

        const submitBtn = document.querySelector('#add-form .btn-submit');
        const submitText = document.getElementById('add-submit-text');
        submitBtn.disabled = true;
        if (submitText) submitText.textContent = editId ? 'Mentés...' : 'Feltöltés...';

        try {
            const payload = {
                title, category, coverFile, magnetLink, torrentFile, description,
                streamUrl: category === 'Sorozat' ? '' : streamUrl,
                downloadUrl, trailers, seasons
            };

            if (editId) {
                await driveAPI.updateTorrent(editId, payload);
                this.showToast('Sikeresen frissítve!', 'success');
            } else {
                await driveAPI.addTorrent(payload);
                this.showToast('Sikeresen hozzáadva!', 'success');
            }

            document.getElementById('add-modal').classList.remove('active');
            this.resetAddForm();
            await this.loadTorrents();
        } catch (error) {
            console.error('Add/edit torrent error:', error);
            this.showToast(error.message || 'Hiba történt!', 'error');
        } finally {
            submitBtn.disabled = false;
            if (submitText) submitText.textContent = editId ? 'Mentés' : 'Torrent Feltöltése';
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