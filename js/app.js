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
        // Check login state
        if (isLoggedIn()) {
            this.showMainPage();
        } else {
            this.showLoginPage();
        }
        this.bindEvents();
    }

    showLoginPage() {
        document.getElementById('login-page').classList.add('active');
        document.getElementById('main-page').classList.remove('active');
    }

    async showMainPage() {
        document.getElementById('login-page').classList.remove('active');
        document.getElementById('main-page').classList.add('active');
        
        // Show admin UI elements
        if (isAdmin()) {
            document.body.classList.add('admin-mode');
        }

        // Check if API key is configured
        if (!CONFIG.GOOGLE_API_KEY) {
            this.showConfigWarning();
            return;
        }

        // Load data
        await this.loadTorrents();

        // Initialize OAuth if admin and client ID is set
        if (isAdmin() && CONFIG.GOOGLE_CLIENT_ID) {
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
                    <div class="card-cover" style="${coverStyle}">
                        ${!torrent.coverUrl ? `<div class="card-cover-placeholder">${categoryInfo.emoji}</div>` : ''}
                        <span class="category-badge" style="background: ${categoryInfo.color}">${categoryInfo.emoji} ${torrent.category}</span>
                    </div>
                    <div class="card-body">
                        <h3 class="card-title" title="${torrent.title}">${torrent.title}</h3>
                        ${dateStr ? `<p class="card-date">${dateStr}</p>` : ''}
                        <div class="card-actions">
                            ${torrent.magnetLink ? `<button class="btn btn-magnet" onclick="app.openMagnet('${this.escapeHtml(torrent.magnetLink)}')" title="Megnyitás torrent klienssel">🧲 Magnet</button>` : ''}
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
        // Login form
        const loginForm = document.getElementById('login-form');
        if (loginForm) {
            loginForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const username = document.getElementById('username-input').value;
                const password = document.getElementById('password-input').value;
                const errorEl = document.getElementById('login-error');
                
                const success = await login(username, password);
                if (success) {
                    errorEl.textContent = '';
                    this.showMainPage();
                } else {
                    errorEl.textContent = 'Hibás felhasználónév vagy jelszó!';
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

    // Open magnet link
    openMagnet(magnetLink) {
        window.location.href = magnetLink.trim();
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
        modal.querySelector('.detail-cover').style.backgroundImage = torrent.coverUrl ? `url('${torrent.coverUrl}')` : '';
        modal.querySelector('.detail-cover').classList.toggle('no-cover', !torrent.coverUrl);
        modal.querySelector('.detail-title').textContent = torrent.title;
        modal.querySelector('.detail-category').innerHTML = `<span style="color: ${categoryInfo.color}">${categoryInfo.emoji} ${torrent.category}</span>`;
        modal.querySelector('.detail-date').textContent = dateStr;
        modal.querySelector('.detail-description').textContent = torrent.description || 'Nincs leírás.';
        
        const actionsEl = modal.querySelector('.detail-actions');
        actionsEl.innerHTML = '';
        if (torrent.magnetLink) {
            actionsEl.innerHTML += `<button class="btn btn-magnet btn-lg" onclick="app.openMagnet('${this.escapeHtml(torrent.magnetLink)}')">🧲 Megnyitás Magnet Linkkel</button>`;
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
