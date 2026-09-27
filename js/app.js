/**
 * Denji-T · App
 * Editorial index / galéria, takeover részletek, admin űrlapok, parancssáv.
 */

const KEY_FAVS = 'denjit_favs';
const KEY_RECENT = 'denjit_recent';
const KEY_WATCH = 'denjit_watch';
// A Streamtape get_video tokenjei időkorlátosak, ezért rövid életű a gyorsítótár.
const STREAM_CACHE_TTL = 5 * 60 * 1000;
const YOUTUBE_ID_RE = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

class App {
    constructor() {
        this.torrents = [];
        this.filteredTorrents = [];
        this.currentFilters = {
            search: '',
            categories: new Set(CONFIG.CATEGORIES),
            sort: 'date-new',
            view: 'all'
        };
        this.favs = new Set(Store.get(KEY_FAVS, []));
        this.recent = Store.get(KEY_RECENT, []);
        this.watch = Store.get(KEY_WATCH, {});
        this.cmdkItems = [];
        this.cmdkIndex = 0;
        // Reklámmentes lejátszás: feloldott linkek gyorsítótára + versenyhelyzet-védelem
        this._streamCache = new Map();
        this._playToken = 0;
        this.player = null;
        // Admin űrlap: feltöltendő / meglévő feliratok, illetve a szerkesztés kiinduló állapota
        this.subsDraft = [];
        this._subUid = 0;
        this._editOriginal = null;
        this._coverObjectUrl = null;
    }

    /* ============================================================
       INDÍTÁS
       ============================================================ */
    async init() {
        this.measureScrollbar();
        window.addEventListener('resize', debounce(() => this.measureScrollbar(), 200));
        this.player = new Player(
            document.getElementById('cinema-player-wrapper'),
            document.getElementById('cinema-player-video'));
        this.bindEvents();

        if (isLoggedIn()) this.showMainPage();
        else this.showLoginPage();

        try { await this.syncPasscodesFromDrive(); } catch (e) {}
    }

    showLoginPage() {
        document.getElementById('login-page').classList.add('active');
        document.getElementById('main-page').classList.remove('active');
        document.body.style.overflow = '';
        setTimeout(() => document.getElementById('passcode-input')?.focus({ preventScroll: true }), 400);
    }

    async showMainPage() {
        document.getElementById('login-page').classList.remove('active');
        document.getElementById('main-page').classList.add('active');
        document.body.style.overflow = '';

        const user = getCurrentUser();
        const name = user ? (user.displayName || user.username) : '';
        this.setText('user-greeting', name.toLowerCase());
        this.setText('user-pop-role', isAdmin() ? 'adminisztrátor' : 'vendég');
        this.setText('hero-eyebrow', isAdmin() ? 'Admin nézet' : 'Privát médiakönyvtár');

        document.body.classList.toggle('admin-mode', isAdmin());
        this.syncNavPlacement();
        this.updateHeaderTone();

        if (!CONFIG.GOOGLE_API_KEY) return this.showConfigWarning();

        await this.loadTorrents();

        if (isAdmin() && (CONFIG.GOOGLE_CLIENT_ID || localStorage.getItem('denjit_client_id'))) {
            driveAPI.initOAuth();
        }
    }

    setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    // A teljes szélességű sávok pontos méretéhez kell a görgetősáv szélessége
    measureScrollbar() {
        const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
        document.documentElement.style.setProperty('--sbw', `${sbw}px`);
    }

    /* ============================================================
       ADATBETÖLTÉS
       ============================================================ */
    async loadTorrents({ silent = false } = {}) {
        const cached = this.torrents.length ? null : driveAPI.getPersistedTorrents();
        if (cached && cached.length) {
            this.torrents = cached;
            this.applyFilters();
            this.setStatus(`Gyorsítótár · ${timeAgo(driveAPI.getPersistedAt())}`);
        } else if (!silent) {
            this.renderSkeletons();
            this.setStatus('Betöltés…');
        }

        UI.progress(true);
        try {
            this.torrents = await driveAPI.loadAllTorrents();
            this.applyFilters();
            this.setStatus(`Szinkronizálva · ${new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })}`);

            clearTimeout(this._settleTimer);
            this._settleTimer = setTimeout(() => {
                driveAPI.persistTorrents(this.torrents);
                if (!UI.anyModalOpen()) this.applyFilters();
            }, 2600);
        } catch (error) {
            console.error('Failed to load torrents:', error);
            if (!this.torrents.length) {
                this.showError('Nem sikerült betölteni a könyvtárat. Ellenőrizd a kapcsolatot és a Drive beállításokat.');
            } else {
                UI.toast('A frissítés nem sikerült — a mentett lista látható.', 'error');
            }
            this.setStatus('Offline · mentett lista');
        } finally {
            UI.progress(false);
        }
    }

    setStatus(text) {
        this.setText('sync-line', text);
        this.setText('foot-status', text);
    }

    showConfigWarning() {
        document.getElementById('torrent-grid').innerHTML = `
            <div class="state">
                <h3 class="state-title">Konfiguráció szükséges</h3>
                <p class="state-text">A Google Drive API használatához add meg az API kulcsot a <code>js/config.js</code> fájlban.</p>
                <ol>
                    <li>Hozz létre egy Google Cloud projektet</li>
                    <li>Engedélyezd a Google Drive API-t</li>
                    <li>Hozz létre egy API kulcsot</li>
                    <li>Írd be a <code>CONFIG.GOOGLE_API_KEY</code> mezőbe</li>
                </ol>
            </div>`;
    }

    showError(message) {
        document.getElementById('torrent-grid').innerHTML = `
            <div class="state">
                <h3 class="state-title">Valami félrement</h3>
                <p class="state-text">${esc(message)}</p>
                <button class="pill pill-light" data-state-act="retry">Újrapróbálás <span class="pill-arrow">→</span></button>
            </div>`;
    }

    /* ============================================================
       SZŰRÉS
       ============================================================ */
    applyFilters() {
        let results = this.visibleLibrary();

        if (this.currentFilters.view === 'fav') {
            results = results.filter(t => this.favs.has(t.id));
        } else if (this.currentFilters.view === 'recent') {
            const order = new Map(this.recent.map((r, i) => [r.id, i]));
            results = results.filter(t => order.has(t.id));
            results.sort((a, b) => order.get(a.id) - order.get(b.id));
        }

        if (this.currentFilters.search) {
            const q = this.currentFilters.search.toLowerCase().trim();
            results = results.filter(t =>
                t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
        }

        results = results.filter(t => this.currentFilters.categories.has(t.category));

        if (this.currentFilters.view !== 'recent') {
            switch (this.currentFilters.sort) {
                case 'name-asc': results.sort((a, b) => a.title.localeCompare(b.title, 'hu')); break;
                case 'name-desc': results.sort((a, b) => b.title.localeCompare(a.title, 'hu')); break;
                case 'date-new': results.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime)); break;
                case 'date-old': results.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime)); break;
            }
        }

        this.filteredTorrents = results;
        this.measureScrollbar();
        this.renderGrid();
        this.renderCounts();
        this.renderHead();
        this.renderContinue();
    }

    /* A 7777-es kód csak a magyar tartalmakat látja, a vendégek csak a nem magyarokat.
       Mindig új tömböt ad vissza, így a hívó nyugodtan rendezheti. */
    visibleLibrary() {
        if (is7777User()) return this.torrents.filter(t => !!t.isMagyar);
        if (!isAdmin()) return this.torrents.filter(t => !t.isMagyar);
        return [...this.torrents];
    }

    renderCounts() {
        const lib = this.visibleLibrary();
        const recentIds = new Set(this.recent.map(r => r.id));
        const byCategory = new Map(CONFIG.CATEGORIES.map(c => [c, 0]));
        let favs = 0;
        let recent = 0;

        for (const t of lib) {
            if (this.favs.has(t.id)) favs++;
            if (recentIds.has(t.id)) recent++;
            if (byCategory.has(t.category)) byCategory.set(t.category, byCategory.get(t.category) + 1);
        }

        const set = (key, val) => document.querySelectorAll(`[data-count="${key}"]`).forEach(el => el.textContent = val);
        set('all', lib.length);
        set('fav', favs);
        set('recent', recent);

        const cats = CONFIG.CATEGORIES.map(c => `${c} ${byCategory.get(c)}`);
        this.setText('hero-meta', `${lib.length} tartalom — ${cats.join(' · ')}`);
    }

    renderHead() {
        const titles = { all: 'Teljes könyvtár', fav: 'Mentett tételek', recent: 'Folytatás' };
        this.setText('page-title', titles[this.currentFilters.view] || 'Könyvtár');

        const n = this.filteredTorrents.length;
        const total = this.visibleLibrary().length;
        this.setText('result-count', this.currentFilters.search
            ? `${n} találat — „${this.currentFilters.search}”`
            : `${n} tétel${n !== total ? ` / ${total}` : ''}`);

        const wrap = document.getElementById('active-filters');
        if (!wrap) return;
        const pills = [];
        if (this.currentFilters.search) {
            pills.push(`<button class="tag-pill" data-clear="search">„${esc(this.currentFilters.search)}” ✕</button>`);
        }
        CONFIG.CATEGORIES.forEach(cat => {
            if (!this.currentFilters.categories.has(cat)) {
                pills.push(`<button class="tag-pill" data-clear="cat" data-cat="${cat}">${cat} rejtve ✕</button>`);
            }
        });
        if (this.currentFilters.view !== 'all') {
            pills.push(`<button class="tag-pill" data-clear="view">${titles[this.currentFilters.view]} ✕</button>`);
        }
        wrap.innerHTML = pills.join('');
    }

    /* ============================================================
       RENDER
       ============================================================ */
    renderSkeletons(count = 12) {
        document.getElementById('torrent-grid').innerHTML = Array.from({ length: count }, () => `
            <div class="skel-row">
                <div class="skel tall"></div>
                <div class="skel"></div>
                <div class="skel short"></div>
            </div>`).join('');
    }

    thumb(url, w = 420) {
        if (!url) return '';
        return url.includes('googleusercontent.com') ? `${url}=w${w}` : url;
    }

    playableInfo(t) {
        const seasons = t.seasons?.length ? t.seasons : (t.episodes?.length ? [{ season: 1, episodes: t.episodes }] : null);
        const epCount = seasons ? seasons.reduce((s, x) => s + (x.episodes?.length || 0), 0) : 0;
        return { seasons, epCount, canStream: !!(t.streamUrl || epCount) };
    }

    renderGrid() {
        const list = document.getElementById('torrent-grid');

        const key = this.filteredTorrents.map(t => t.id).join('|');
        const animate = key !== this._lastKey;
        this._lastKey = key;

        if (!this.filteredTorrents.length) {
            list.innerHTML = this.emptyState();
            return;
        }

        CoverLoader.reset();
        list.innerHTML = this.filteredTorrents
            .map((t, i) => this.cardHTML(t, i, animate))
            .join('');
        list.querySelectorAll('.card-art img[data-src]').forEach(img => CoverLoader.load(img));

        if (animate) this.observeReveals(list);
    }

    /* Beúszás görgetéskor */
    observeReveals(scope) {
        const targets = [...scope.querySelectorAll('.rv:not(.in)')];
        if (!targets.length) return;

        if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
            targets.forEach(el => el.classList.add('in'));
            return;
        }

        // Ami már látszik, azonnal megjelenik — csak a lentebbi elemek úsznak be
        const pending = [];
        targets.forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.top < window.innerHeight * 0.92) el.classList.add('in');
            else pending.push(el);
        });
        if (!pending.length) return;

        this._revealObs?.disconnect();
        this._revealObs = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                entry.target.classList.add('in');
                obs.unobserve(entry.target);
            });
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.02 });
        pending.forEach(el => this._revealObs.observe(el));

        // Biztonsági háló: ha az observer bármiért nem sülne el, semmi nem marad rejtve
        clearTimeout(this._revealFallback);
        this._revealFallback = setTimeout(() => this.revealInView(), 2000);
    }

    // Görgetéskori tartalék: ami a képernyőre ért, az mindenképp megjelenik
    revealInView() {
        const pending = document.querySelectorAll('.rv:not(.in)');
        if (!pending.length) return;
        const limit = window.innerHeight * 0.95;
        pending.forEach(el => {
            if (el.getBoundingClientRect().top < limit) el.classList.add('in');
        });
    }

    actionsHTML(t, info) {
        const acts = [];
        if (info.canStream) acts.push('<button class="row-act" data-act="play">Lejátszás</button>');
        if (t.downloadUrl) acts.push('<button class="row-act" data-act="download">Letöltés</button>');
        if (t.magnetLink || t.magnetFileId) acts.push('<button class="row-act" data-act="magnet">Magnet</button>');
        if (t.torrentFileId) acts.push('<button class="row-act" data-act="torrent">Torrent</button>');
        acts.push(`<button class="row-act ${this.favs.has(t.id) ? 'is-on' : ''}" data-act="fav">${this.favs.has(t.id) ? 'Mentve' : 'Mentés'}</button>`);
        if (isAdmin()) {
            acts.push('<button class="row-act" data-act="edit">Szerk.</button>');
            acts.push('<button class="row-act" data-act="delete">Törlés</button>');
        }
        return acts.join('');
    }

    /* A borító a főszereplő: poszterarányú kártya, a részletek hoverre nyílnak ki. */
    cardHTML(t, i, animate = true) {
        const info = this.playableInfo(t);
        const progress = this.progressOf(t, info);
        const cover = this.thumb(t.coverUrl, 500);
        const saved = this.favs.has(t.id);
        const year = yearOf(t.createdTime);

        const bits = [];
        if (year) bits.push(esc(year));
        if (info.epCount) bits.push(info.seasons.length > 1 ? `${info.seasons.length} évad` : `${info.epCount} rész`);
        else if (t.streamUrl) bits.push('Stream');
        if (t.isMagyar && (isAdmin() || is7777User())) bits.push('Magyar');

        return `
        <article class="card${animate ? ' rv' : ''}" data-id="${t.id}" tabindex="0" style="--i:${Math.min(i, 30)}">
            <div class="card-art">
                <span class="card-blank">${esc(t.title)}</span>
                ${cover
                    ? `<img class="card-cover" data-src="${esc(cover)}" alt="" decoding="async" referrerpolicy="no-referrer">`
                    : ''}
                <span class="card-kind">${esc(t.category)}</span>
                <button class="card-fav${saved ? ' is-on' : ''}" data-act="fav" aria-label="${saved ? 'Mentve' : 'Mentés'}">${saved ? '★' : '☆'}</button>
                <div class="card-veil">
                    ${info.canStream ? '<button class="card-play" data-act="play">▶ Lejátszás</button>' : ''}
                </div>
                <span class="card-bar"${progress ? '' : ' hidden'}><i style="width:${progress}%"></i></span>
            </div>
            <div class="card-info">
                <h3 class="card-title">${esc(t.title)}</h3>
                <div class="card-meta">${bits.map(b => `<span>${b}</span>`).join('<span class="dot"></span>')}</div>
            </div>
            <div class="row-actions">${this.actionsHTML(t, info)}</div>
        </article>`;
    }

    emptyState() {
        const v = this.currentFilters.view;
        if (v === 'fav') {
            return `<div class="state">
                <h3 class="state-title">Még nincs mentett tétel</h3>
                <p class="state-text">Vidd az egeret egy sor fölé, és válaszd a „Mentés” gombot — itt gyűlnek össze.</p>
                <button class="pill pill-light" data-state-act="all">Teljes könyvtár <span class="pill-arrow">→</span></button>
            </div>`;
        }
        if (v === 'recent') {
            return `<div class="state">
                <h3 class="state-title">Nincs mit folytatni</h3>
                <p class="state-text">Amit megnyitsz, itt jelenik meg — sorozatoknál a legutóbbi résszel együtt.</p>
                <button class="pill pill-light" data-state-act="all">Teljes könyvtár <span class="pill-arrow">→</span></button>
            </div>`;
        }
        return `<div class="state">
            <h3 class="state-title">Nincs találat</h3>
            <p class="state-text">Próbálj másik kifejezést, vagy kapcsold vissza a rejtett kategóriákat.</p>
            <button class="pill pill-light" data-state-act="reset">Szűrők törlése <span class="pill-arrow">→</span></button>
        </div>`;
    }

    renderContinue() {
        const section = document.getElementById('continue-rail');
        const track = document.getElementById('continue-track');
        if (!section || !track) return;

        const lib = this.visibleLibrary();
        const items = this.recent
            .map(r => lib.find(t => t.id === r.id))
            .filter(Boolean)
            .slice(0, 8);

        const show = this.currentFilters.view === 'all' && !this.currentFilters.search && items.length >= 2;
        section.hidden = !show;
        if (!show) return;

        track.innerHTML = items.map(t => {
            const w = this.watch[t.id];
            const rec = this.recent.find(r => r.id === t.id);
            const info = this.playableInfo(t);
            const percent = this.progressOf(t, info);
            // A mentett pozíció sorszám (index) — a kiírásba a valódi évad- és részszám kell
            const season = w?.s != null ? info.seasons?.[w.s] : null;
            const ep = season?.episodes?.[w.e];
            const resume = ep ? `${season.season}. évad ${ep.ep}. rész` : 'Megnyitás';
            return `
                <article class="cont" data-id="${t.id}">
                    <button class="cont-open" data-cont-act="open">
                        <span class="label cont-cat">${esc(t.category)}</span>
                        <span class="cont-name">${esc(t.title)}</span>
                        <span class="cont-resume">${esc(resume)} <i>→</i></span>
                        <span class="label cont-time">${rec ? timeAgo(rec.ts) : ''}</span>
                    </button>
                    <button class="cont-remove" data-cont-act="remove" title="Eltávolítás a listáról" aria-label="Eltávolítás">✕</button>
                    ${percent ? `<span class="cont-bar"><i style="width:${percent}%"></i></span>` : ''}
                </article>`;
        }).join('');
    }

    removeRecent(id) {
        const t = this.torrents.find(x => x.id === id);
        this.recent = this.recent.filter(r => r.id !== id);
        Store.set(KEY_RECENT, this.recent);
        this.renderContinue();
        this.renderCounts();
        if (this.currentFilters.view === 'recent') this.applyFilters();
        UI.toast(`Eltávolítva a folytatásból${t ? ` — ${t.title}` : ''}`, 'info', 2400);
    }

    /* ============================================================
       ÁLLAPOTOK
       ============================================================ */
    toggleFav(id) {
        const t = this.torrents.find(x => x.id === id);
        const was = this.favs.has(id);
        if (was) this.favs.delete(id); else this.favs.add(id);
        Store.set(KEY_FAVS, [...this.favs]);
        UI.toast(`${was ? 'Eltávolítva' : 'Mentve'}${t ? ` — ${t.title}` : ''}`, was ? 'info' : 'success', 2400);

        if (this.currentFilters.view === 'fav') {
            this.applyFilters();
        } else {
            document.querySelectorAll(`[data-id="${id}"] [data-act="fav"]`).forEach(btn => {
                btn.classList.toggle('is-on', !was);
                // A poszteren csillag jelzi a mentést, a művelet-listában szöveg
                if (btn.classList.contains('card-fav')) {
                    btn.textContent = was ? '☆' : '★';
                    btn.setAttribute('aria-label', was ? 'Mentés' : 'Mentve');
                } else {
                    btn.textContent = was ? 'Mentés' : 'Mentve';
                }
            });
            this.renderCounts();
        }
        const favBtn = document.getElementById('cinema-fav-btn');
        if (favBtn && this.currentDetailId === id) favBtn.textContent = this.favs.has(id) ? 'mentve' : 'mentés';
    }

    pushRecent(id) {
        this.recent = this.recent.filter(r => r.id !== id);
        this.recent.unshift({ id, ts: Date.now() });
        this.recent = this.recent.slice(0, 24);
        Store.set(KEY_RECENT, this.recent);
    }

    markWatched(id, sIdx, eIdx) {
        const entry = this.watch[id] || { eps: {} };
        entry.s = sIdx;
        entry.e = eIdx;
        entry.eps[`${sIdx}-${eIdx}`] = 1;
        entry.ts = Date.now();
        this.watch[id] = entry;
        Store.set(KEY_WATCH, this.watch);
    }

    progressOf(t, info) {
        const w = this.watch[t.id];
        if (!w || !info.epCount) return 0;
        return Math.min(100, Math.round((Object.keys(w.eps || {}).length / info.epCount) * 100));
    }

    refreshRowState(id) {
        const t = this.torrents.find(x => x.id === id);
        const card = document.querySelector(`.card[data-id="${id}"]`);
        if (!t || !card) return;
        const percent = this.progressOf(t, this.playableInfo(t));
        const bar = card.querySelector('.card-bar');
        if (!bar) return;
        bar.hidden = !percent;
        bar.querySelector('i').style.width = `${percent}%`;
    }

    /* ============================================================
       ESEMÉNYEK
       ============================================================ */
    bindEvents() {
        /* --- Belépés --- */
        document.querySelectorAll('.mode-link').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.mode-link').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.login-form').forEach(f => f.classList.remove('active'));
                btn.classList.add('active');
                const mode = btn.dataset.mode;
                document.getElementById(mode === 'passcode' ? 'passcode-login-form' : 'login-form').classList.add('active');
                document.getElementById(mode === 'passcode' ? 'passcode-input' : 'username-input')?.focus({ preventScroll: true });
            });
        });

        document.querySelectorAll('.reveal').forEach(btn => {
            btn.addEventListener('click', () => {
                const input = document.getElementById(btn.dataset.reveal);
                if (!input) return;
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.classList.toggle('on', show);
                btn.textContent = show ? 'rejtsd' : 'mutasd';
                input.focus({ preventScroll: true });
            });
        });

        const capsHint = document.getElementById('caps-hint');
        document.querySelectorAll('#passcode-input, #password-input').forEach(inp => {
            inp.addEventListener('keyup', (e) => {
                if (capsHint && e.getModifierState) capsHint.hidden = !e.getModifierState('CapsLock');
            });
        });

        document.getElementById('passcode-login-form')?.addEventListener('submit', (e) => {
            e.preventDefault();
            const res = loginWithPasscode(
                document.getElementById('passcode-input').value,
                document.getElementById('remember-me')?.checked
            );
            this.afterLogin(res, 'passcode-error');
        });

        document.getElementById('login-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('login-btn');
            btn.disabled = true;
            const res = await loginWithPassword(
                document.getElementById('username-input').value,
                document.getElementById('password-input').value,
                document.getElementById('remember-me')?.checked
            );
            btn.disabled = false;
            this.afterLogin(res, 'login-error');
        });

        document.getElementById('logout-btn')?.addEventListener('click', () => logout());

        /* --- Navigáció --- */
        document.getElementById('brand-home')?.addEventListener('click', () => {
            this.setView('all');
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        document.getElementById('refresh-btn')?.addEventListener('click', () => this.refresh());
        document.getElementById('menu-refresh')?.addEventListener('click', () => { UI.closeAllPops(); this.refresh(); });
        document.getElementById('cmdk-btn')?.addEventListener('click', () => this.openCmdk());
        ['user-chip', 'mobile-menu-btn'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', (e) => {
                e.stopPropagation();
                UI.togglePop(document.getElementById('user-pop'));
            });
        });

        /* --- Szűrők --- */
        document.getElementById('category-filters')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.cat-link');
            if (!btn) return;
            const cat = btn.dataset.category;
            if (this.currentFilters.categories.has(cat) && this.currentFilters.categories.size > 0) {
                this.currentFilters.categories.delete(cat);
                btn.classList.remove('active');
            } else {
                this.currentFilters.categories.add(cat);
                btn.classList.add('active');
            }
            this.applyFilters();
        });

        document.querySelectorAll('#view-nav .ctrl-link').forEach(btn => {
            btn.addEventListener('click', () => this.setView(btn.dataset.view));
        });

        const searchInput = document.getElementById('search-input');
        const onSearch = debounce(() => {
            this.currentFilters.search = searchInput.value;
            this.applyFilters();
        }, 140);
        searchInput?.addEventListener('input', () => {
            document.getElementById('search-clear').hidden = !searchInput.value;
            onSearch();
        });
        document.getElementById('search-clear')?.addEventListener('click', () => {
            this.clearSearch();
            searchInput.focus();
        });

        document.getElementById('sort-select')?.addEventListener('change', (e) => {
            this.currentFilters.sort = e.target.value;
            this.applyFilters();
        });

        document.getElementById('active-filters')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-clear]');
            if (!btn) return;
            if (btn.dataset.clear === 'search') {
                this.clearSearch();
            } else if (btn.dataset.clear === 'cat') {
                this.currentFilters.categories.add(btn.dataset.cat);
                document.querySelector(`.cat-link[data-category="${btn.dataset.cat}"]`)?.classList.add('active');
                this.applyFilters();
            } else {
                this.setView('all');
            }
        });

        /* --- Lista --- */
        const list = document.getElementById('torrent-grid');
        list?.addEventListener('click', (e) => {
            const stateBtn = e.target.closest('[data-state-act]');
            if (stateBtn) {
                const act = stateBtn.dataset.stateAct;
                if (act === 'all') this.setView('all');
                else if (act === 'reset') this.resetFilters();
                else this.loadTorrents();
                return;
            }

            const item = e.target.closest('.card');
            if (!item) return;
            const id = item.dataset.id;
            const actBtn = e.target.closest('[data-act]');
            if (!actBtn) return this.openDetail(id);

            e.stopPropagation();
            const t = this.torrents.find(x => x.id === id);
            switch (actBtn.dataset.act) {
                case 'fav': return this.toggleFav(id);
                case 'play': return this.openDetail(id);
                case 'download': return t?.downloadUrl && window.open(t.downloadUrl, '_blank', 'noopener');
                case 'magnet': return this.openMagnet(id);
                case 'torrent': return this.downloadTorrent(t.torrentFileId, t.torrentFileName);
                case 'edit': return this.openEditModal(id);
                case 'delete': return this.confirmDelete(id, t?.title || '');
            }
        });

        list?.addEventListener('keydown', (e) => {
            const item = e.target.closest('.card');
            if (item && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                this.openDetail(item.dataset.id);
            }
        });

        document.getElementById('continue-track')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-cont-act]');
            const card = e.target.closest('.cont');
            if (!btn || !card) return;
            if (btn.dataset.contAct === 'remove') this.removeRecent(card.dataset.id);
            else this.openDetail(card.dataset.id);
        });
        document.getElementById('clear-recent-btn')?.addEventListener('click', async () => {
            const ok = await UI.confirm({
                title: 'Előzmények törlése',
                text: 'A „Folytatás” lista kiürül. A mentett tételek megmaradnak.',
                okLabel: 'Törlés', kicker: 'Előzmények'
            });
            if (!ok) return;
            this.recent = [];
            Store.set(KEY_RECENT, []);
            this.applyFilters();
            UI.toast('Előzmények törölve.', 'success');
        });

        /* --- Takeover bezárás --- */
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                const host = btn.closest('.takeover, .sheet');
                if (!host) return;
                if (host.id === 'detail-modal') this.closeDetail();
                else UI.closeModal(host);
            });
        });

        /* --- Admin --- */
        document.getElementById('add-torrent-fab')?.addEventListener('click', () => this.openAddModal());
        document.getElementById('add-category')?.addEventListener('change', () => this.updateStreamFormByCategory());
        document.getElementById('add-season-btn')?.addEventListener('click', () => this.addSeasonBlock());
        document.getElementById('btn-parse-series-links')?.addEventListener('click', () => this.handleBulkSeriesLinks(true));
        document.getElementById('btn-clear-bulk-links')?.addEventListener('click', () => this.clearBulkSeriesLinks());
        document.getElementById('add-series-bulk-links')?.addEventListener('paste', () => {
            setTimeout(() => this.handleBulkSeriesLinks(true), 60);
        });

        // .txt linklista a Streamtape mezőbe (gombbal vagy ráhúzva)
        const txtInput = document.getElementById('stream-txt-input');
        document.querySelectorAll('[data-pick-txt]').forEach(btn => btn.addEventListener('click', () => txtInput?.click()));
        txtInput?.addEventListener('change', () => {
            this.importStreamTxt(txtInput.files[0]);
            txtInput.value = '';   // ugyanaz a fájl újra kiválasztható legyen
        });
        document.querySelectorAll('.txt-drop').forEach(zone =>
            this.bindFileDrop(zone, (files) => this.importStreamTxt(files[0])));

        // Feliratok
        const subsDrop = document.getElementById('subs-drop');
        const subsInput = document.getElementById('subs-input');
        subsDrop?.addEventListener('click', () => subsInput?.click());
        subsDrop?.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            subsInput?.click();
        });
        subsInput?.addEventListener('change', () => {
            this.addSubtitleFiles(subsInput.files);
            subsInput.value = '';
        });
        if (subsDrop) this.bindFileDrop(subsDrop, (files) => this.addSubtitleFiles(files));
        this.bindSubtitleList();

        // Torrent fájl
        const torrentInput = document.getElementById('torrent-input');
        document.getElementById('torrent-pick')?.addEventListener('click', () => torrentInput?.click());
        torrentInput?.addEventListener('change', () => this.syncTorrentPicker());
        document.getElementById('torrent-clear')?.addEventListener('click', () => {
            torrentInput.value = '';
            this.syncTorrentPicker();
        });

        // A mezők mellé ejtett fájlt a böngésző megnyitná — és elveszne a kitöltött űrlap
        ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, (e) => {
            if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
        }));
        document.getElementById('add-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await this.handleAddTorrent();
        });
        document.getElementById('manage-passcodes-btn')?.addEventListener('click', () => {
            UI.closeAllPops();
            this.renderPasscodeList();
            UI.openModal('passcode-modal');
        });
        document.getElementById('add-passcode-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = document.getElementById('new-friend-name').value.trim();
            const code = document.getElementById('new-friend-code').value.trim();
            if (!name || !code) return;
            addPasscode(name, code);
            UI.toast(`Kód elmentve — ${name} · ${code}`, 'success');
            e.target.reset();
            this.renderPasscodeList();
            await this.uploadPasscodesToDrive();
        });
        this.bindDropZone();

        document.getElementById('next-episode-btn')?.addEventListener('click', () => this.playRelativeEpisode(1));

        /* --- Görgetés --- */
        const scrollTop = document.getElementById('scroll-top');
        const progressBar = document.querySelector('#scroll-progress span');
        // Képkockánként egyszer fut le: a görgetés így akkor is sima marad, ha sok kártya van kint
        window.addEventListener('scroll', rafThrottle(() => {
            scrollTop?.classList.toggle('on', window.scrollY > 700);
            this.updateHeaderTone();
            this.revealInView();
            if (progressBar) {
                const max = document.documentElement.scrollHeight - window.innerHeight;
                progressBar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
            }
        }), { passive: true });
        scrollTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

        window.addEventListener('resize', debounce(() => this.syncNavPlacement(), 200));

        // Teljes képernyős nézet alatt a borítófalat megállítjuk, a főoldalt elrejtjük, a csillagmező háttér fut tovább
        document.addEventListener('ui:overlay', () => {
            const takeoverActive = !!document.querySelector('.takeover.active');
            document.body.classList.toggle('takeover-open', takeoverActive);
        });

        this.bindCmdk();
        this.bindShortcuts();
    }

    afterLogin(res, errorId) {
        const el = document.getElementById(errorId);
        if (res.success) {
            el.textContent = '';
            this.showMainPage();
            UI.toast(`Üdv, ${res.user.displayName || res.user.username}.`, 'success');
        } else {
            el.textContent = res.error;
            el.classList.add('shake');
            setTimeout(() => el.classList.remove('shake'), 700);
        }
    }

    /* A kategóriaváltók mobilon a vezérlősorba költöznek */
    syncNavPlacement() {
        const nav = document.getElementById('category-filters');
        const controls = document.querySelector('.controls');
        const header = document.querySelector('#header .nav-left');
        if (!nav || !controls) return;

        const mobile = window.matchMedia('(max-width: 760px)').matches;
        if (mobile && nav.parentElement !== controls) {
            controls.insertBefore(nav, controls.firstChild);
            nav.classList.add('control-group');
        } else if (!mobile && nav.parentElement === controls) {
            header.after(nav);
            nav.classList.remove('control-group');
        }
    }

    updateHeaderTone() {
        const header = document.getElementById('header');
        const hero = document.querySelector('.hero');
        if (!header || !hero) return;
        const past = window.scrollY > hero.offsetHeight - 90;
        header.classList.toggle('on-paper', past);
    }

    setView(view) {
        this.currentFilters.view = view;
        document.querySelectorAll('#view-nav .ctrl-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));
        this.applyFilters();
        UI.closeAllPops();
    }

    /* A keresőmező kiürítése — a törlés gomb és a szűrőcímke is ezt hívja */
    clearSearch({ rerender = true } = {}) {
        const input = document.getElementById('search-input');
        if (input) input.value = '';
        const clearBtn = document.getElementById('search-clear');
        if (clearBtn) clearBtn.hidden = true;
        this.currentFilters.search = '';
        if (rerender) this.applyFilters();
    }

    resetFilters() {
        this.clearSearch({ rerender: false });
        this.currentFilters.categories = new Set(CONFIG.CATEGORIES);
        this.currentFilters.view = 'all';
        document.querySelectorAll('.cat-link').forEach(b => b.classList.add('active'));
        document.querySelectorAll('#view-nav .ctrl-link').forEach(b => b.classList.toggle('active', b.dataset.view === 'all'));
        this.applyFilters();
    }

    async refresh() {
        driveAPI.clearCache();
        await this.loadTorrents({ silent: true });
        UI.toast('Könyvtár frissítve.', 'success', 2400);
    }

    /* ============================================================
       GYORSBILLENTYŰK
       ============================================================ */
    /**
     * Csak a legszükségesebb billentyűkezelés marad:
     * Esc = bezárás, Ctrl/⌘+K = keresőpaletta, nyilak = rész léptetése a lejátszóban.
     * Amíg a saját lejátszó fut, a billentyűket az kapja (szóköz, nyilak, F, M, C, N, P).
     */
    bindShortcuts() {
        document.addEventListener('keydown', (e) => {
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

            if (e.key === 'Escape') {
                // Előbb a lejátszó menüje, teljes képernyőn pedig csak abból lépünk ki
                if (this.player?.closeMenus()) return;
                if (document.fullscreenElement || document.webkitFullscreenElement) return;
                if (document.getElementById('cmdk').classList.contains('active')) return this.closeCmdk();
                const open = document.querySelector('.sheet.active, .takeover.active');
                if (open) {
                    if (open.id === 'detail-modal') this.closeDetail();
                    else UI.closeModal(open);
                    return;
                }
                UI.closeAllPops();
                return;
            }

            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                return this.openCmdk();
            }

            if (document.getElementById('detail-modal').classList.contains('active') && !typing) {
                if (this.player?.handleKey(e)) return;
                if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && this.currentSeasons) {
                    e.preventDefault();
                    this.playRelativeEpisode(e.key === 'ArrowRight' ? 1 : -1);
                }
            }
        });
    }

    /* ============================================================
       PARANCSSÁV
       ============================================================ */
    bindCmdk() {
        const input = document.getElementById('cmdk-input');
        const overlay = document.getElementById('cmdk');

        overlay?.addEventListener('click', (e) => { if (e.target === overlay) this.closeCmdk(); });
        input?.addEventListener('input', () => this.renderCmdk(input.value));
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); this.moveCmdk(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveCmdk(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); this.cmdkItems[this.cmdkIndex]?.run(); }
        });
        document.getElementById('cmdk-results')?.addEventListener('click', (e) => {
            const item = e.target.closest('.cmdk-item');
            if (item) this.cmdkItems[parseInt(item.dataset.idx, 10)]?.run();
        });
    }

    openCmdk() {
        const overlay = document.getElementById('cmdk');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
        const input = document.getElementById('cmdk-input');
        input.value = '';
        this.renderCmdk('');
        setTimeout(() => input.focus(), 60);
    }

    closeCmdk() {
        document.getElementById('cmdk').classList.remove('active');
        if (!document.querySelector('.takeover.active, .sheet.active')) document.body.style.overflow = '';
    }

    moveCmdk(delta) {
        if (!this.cmdkItems.length) return;
        this.cmdkIndex = (this.cmdkIndex + delta + this.cmdkItems.length) % this.cmdkItems.length;
        const results = document.getElementById('cmdk-results');
        results.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('sel', i === this.cmdkIndex));
        results.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' });
    }

    renderCmdk(query) {
        const q = (query || '').toLowerCase().trim();
        const results = document.getElementById('cmdk-results');
        this.cmdkItems = [];
        let idx = 0;
        let html = '';

        const items = this.visibleLibrary()
            .filter(t => !q || t.title.toLowerCase().includes(q))
            .slice(0, q ? 20 : 6);

        if (items.length) {
            html += `<div class="cmdk-group"><span class="label">Tartalom</span></div>`;
            html += items.map(t => {
                this.cmdkItems.push({ run: () => { this.closeCmdk(); this.openDetail(t.id); } });
                return `<button class="cmdk-item ${idx === 0 ? 'sel' : ''}" data-idx="${idx++}">
                    <span>${esc(t.title)}</span>
                    <span class="cmdk-sub">${esc(t.category)} ${yearOf(t.createdTime)}</span>
                </button>`;
            }).join('');
        }

        const actions = [
            { title: 'Könyvtár frissítése', run: () => { this.closeCmdk(); this.refresh(); } },
            { title: 'Mentett tételek', run: () => { this.closeCmdk(); this.setView('fav'); } },
            { title: 'Folytatás', run: () => { this.closeCmdk(); this.setView('recent'); } },
            { title: 'Kijelentkezés', run: () => logout() }
        ];
        if (isAdmin()) {
            actions.unshift({ title: 'Új tartalom', run: () => { this.closeCmdk(); this.openAddModal(); } });
            actions.push({ title: 'Belépési kódok', run: () => { this.closeCmdk(); this.renderPasscodeList(); UI.openModal('passcode-modal'); } });
        }

        const matched = actions.filter(a => !q || a.title.toLowerCase().includes(q));
        if (matched.length) {
            html += `<div class="cmdk-group"><span class="label">Parancsok</span></div>`;
            html += matched.map(a => {
                this.cmdkItems.push(a);
                return `<button class="cmdk-item ${idx === 0 ? 'sel' : ''}" data-idx="${idx++}">
                    <span>${esc(a.title)}</span>
                </button>`;
            }).join('');
        }

        this.cmdkIndex = 0;
        results.innerHTML = html || `<div class="cmdk-empty">Nincs találat — „${esc(query)}”</div>`;
    }

    /* ============================================================
       RÉSZLETEK (takeover)
       ============================================================ */
    openDetail(torrentId) {
        const t = this.torrents.find(x => x.id === torrentId);
        if (!t) return;

        this.currentDetailId = torrentId;
        this.currentTorrent = t;
        this.pushRecent(torrentId);

        const modal = document.getElementById('detail-modal');
        const info = this.playableInfo(t);
        const canSeeMagyar = isAdmin() || is7777User();

        modal.querySelector('.detail-category').textContent = t.category;
        modal.querySelector('.detail-date').textContent = formatDate(t.createdTime, true);
        modal.querySelector('.detail-title').textContent = t.title;

        const favBtn = document.getElementById('cinema-fav-btn');
        if (favBtn) {
            favBtn.textContent = this.favs.has(t.id) ? 'mentve' : 'mentés';
            favBtn.onclick = () => this.toggleFav(t.id);
        }

        const badges = [];
        if (t.isMagyar && canSeeMagyar) badges.push('<span class="mark">Magyar</span>');
        if (info.seasons) badges.push(`<span class="mark">${info.seasons.length} évad · ${info.epCount} rész</span>`);
        else if (t.streamUrl) badges.push('<span class="mark">Online nézhető</span>');
        if (t.trailers?.length) badges.push(`<span class="mark">${t.trailers.length} trailer</span>`);
        if (t.downloadUrl) badges.push('<span class="mark">Közvetlen letöltés</span>');
        if (t.magnetLink || t.magnetFileId) badges.push('<span class="mark">Magnet</span>');
        if (t.torrentFileId) badges.push('<span class="mark">Torrent fájl</span>');
        document.getElementById('detail-badges').innerHTML = badges.join('') || '<span class="mark">Nincs extra adat</span>';

        this.renderDescription(t, modal);

        // Média lista
        this.currentMediaList = [];
        this.currentMediaIndex = 0;
        this.currentSeasons = info.seasons;

        this.showPlaceholderCover(t);

        const seriesSelector = document.getElementById('series-episode-selector');
        if (info.seasons) {
            const w = this.watch[t.id] || {};
            const sIdx = Math.min(w.s ?? 0, info.seasons.length - 1);
            const eIdx = Math.min(w.e ?? 0, info.seasons[sIdx].episodes.length - 1);
            this.currentSeasonIndex = sIdx;
            this.currentEpisodeIndex = eIdx;
            const ep = info.seasons[sIdx].episodes[eIdx];
            this.currentMediaList.push({ label: `S${info.seasons[sIdx].season}E${ep.ep}`, url: this.embedUrl(ep.url) });
            this.markWatched(t.id, sIdx, eIdx);
            if (seriesSelector) {
                seriesSelector.style.display = 'block';
                this.renderSeriesPlayer(t);
            }
        } else {
            this.currentSeasonIndex = 0;
            this.currentEpisodeIndex = 0;
            if (seriesSelector) seriesSelector.style.display = 'none';
            if (t.streamUrl) this.currentMediaList.push({ label: 'Film', url: this.embedUrl(t.streamUrl) });
        }

        (t.trailers || []).forEach((url, i) => {
            const id = this.extractYouTubeId(url);
            if (id) this.currentMediaList.push({
                label: `Trailer ${t.trailers.length > 1 ? i + 1 : ''}`.trim(),
                url: `https://www.youtube.com/embed/${id}`
            });
        });

        this.renderMediaTabs();
        this.updateStage();
        this.renderDetailActions(t);

        UI.openModal(modal);
        this.renderContinue();
    }

    /**
     * A lejátszó tartalék képe — akkor látszik, ha nincs se stream, se rész, se trailer.
     * Valódi <img>-ek, nem CSS háttér: így újrapróbálhatók, és a hiba is látszik.
     */
    showPlaceholderCover(t) {
        const placeholder = document.getElementById('cinema-player-placeholder');
        if (!placeholder) return;
        const cover = t.coverUrl ? this.thumb(t.coverUrl, 1200) : '';

        placeholder.dataset.empty = cover ? '' : 'Nincs lejátszható tartalom';
        placeholder.style.display = 'block';

        placeholder.querySelectorAll('img').forEach(el => {
            if (!cover) {
                el.hidden = true;
                el.classList.remove('loaded');
                delete el.dataset.src;
                return;
            }
            el.hidden = false;
            el.dataset.src = cover;
            // A src-t nem vesszük el: a futó kérés megszakítása némán elnyelné az eseményeket.
            if (el.getAttribute('src') !== cover) el.classList.remove('loaded');
            CoverLoader.load(el, () => { placeholder.dataset.empty = 'A borító nem tölthető be'; });
        });
    }

    renderDescription(t, modal) {
        const el = modal.querySelector('.detail-description');
        if (!el) return;
        const none = 'Ehhez a tartalomhoz nincs leírás.';
        if (t.description?.trim() && !t.descriptionCut) {
            el.textContent = t.description.trim();
        } else if (t.descriptionFileId) {
            // A gyorsítótárból jött, rövidített leírás látszik, amíg a teljes megérkezik
            el.textContent = t.description?.trim() || 'Leírás betöltése…';
            driveAPI.readTextFile(t.descriptionFileId, t.title).then(text => {
                if (text?.trim()) {
                    t.description = text.trim();
                    delete t.descriptionCut;
                }
                if (this.currentDetailId === t.id) el.textContent = t.description?.trim() || none;
            }).catch(() => {
                if (this.currentDetailId === t.id) el.textContent = t.description?.trim() || none;
            });
        } else {
            el.textContent = 'Ehhez a tartalomhoz nincs leírás.';
        }
    }

    embedUrl(url) {
        return normalizeStreamUrl(url);
    }

    /* --- Reklámmentes lejátszás ------------------------------------------
       A Streamtape beágyazott lejátszója tele van reklámmal, ezért a szerver
       /api/resolve_stream végpontjával kiszedjük a közvetlen videólinket, és
       a saját <video> elemünkben játsszuk le. Ha bármi hibázik, visszaesünk
       az eredeti iframe-es beágyazásra. */

    isStreamtape(url) {
        return isStreamtapeUrl(url);
    }

    async resolveStream(url) {
        const hit = this._streamCache.get(url);
        if (hit && Date.now() - hit.at < STREAM_CACHE_TTL) return hit.proxy;

        const res = await fetch(apiUrl(`/api/resolve_stream?url=${encodeURIComponent(url)}`));
        if (!res.ok) throw new Error(`resolve_stream HTTP ${res.status}`);
        const data = await res.json();
        if (!data.proxy) throw new Error('a szerver nem talált közvetlen linket');

        // A get_video token IP-hez kötött, ezért a videót is a szerveren át kérjük le
        this._streamCache.set(url, { proxy: apiUrl(data.proxy), at: Date.now() });
        return this._streamCache.get(url).proxy;
    }

    setStageLoading(box, on) {
        box?.classList.toggle('stage-loading', !!on);
    }

    renderMediaTabs() {
        const tabs = document.getElementById('cinema-server-tabs');
        const stage = document.getElementById('cinema-hero-stage');
        stage?.classList.toggle('multi', this.currentMediaList.length > 1);

        if (!tabs) return;
        if (this.currentMediaList.length < 2) {
            tabs.innerHTML = '';
            tabs.style.display = 'none';
        } else {
            tabs.style.display = 'flex';
            tabs.innerHTML = this.currentMediaList.map((m, i) =>
                `<button class="tab-link ${i === this.currentMediaIndex ? 'active' : ''}" data-index="${i}">${esc(m.label)}</button>`).join('');
            tabs.querySelectorAll('.tab-link').forEach(btn => {
                btn.addEventListener('click', () => {
                    this.currentMediaIndex = parseInt(btn.dataset.index, 10);
                    this.updateStage();
                });
            });
        }

        const prev = document.getElementById('cinema-prev-btn');
        const next = document.getElementById('cinema-next-btn');
        if (prev) prev.onclick = () => { this.currentMediaIndex = (this.currentMediaIndex - 1 + this.currentMediaList.length) % this.currentMediaList.length; this.updateStage(); };
        if (next) next.onclick = () => { this.currentMediaIndex = (this.currentMediaIndex + 1) % this.currentMediaList.length; this.updateStage(); };
    }

    updateStage() {
        const placeholder = document.getElementById('cinema-player-placeholder');
        if (!this.currentMediaList.length) {
            this.clearPlayers();
            if (placeholder) placeholder.style.display = 'block';
            return;
        }
        const item = this.currentMediaList[this.currentMediaIndex];
        if (item?.url) this.playEmbed(item.url, this.playbackContext(item));
        document.querySelectorAll('#cinema-server-tabs .tab-link').forEach((b, i) =>
            b.classList.toggle('active', i === this.currentMediaIndex));
    }

    renderDetailActions(t) {
        const el = document.querySelector('#detail-modal .detail-actions');
        if (!el) return;
        const parts = [];
        if (t.downloadUrl) parts.push('<button class="pill pill-light" data-detail-act="download">Közvetlen letöltés <span class="pill-arrow">↓</span></button>');
        if (t.magnetLink || t.magnetFileId) parts.push('<button class="pill pill-light" data-detail-act="magnet">Magnet megnyitása <span class="pill-arrow">→</span></button>');
        if (t.torrentFileId) parts.push('<button class="pill pill-light" data-detail-act="torrent">Torrent fájl <span class="pill-arrow">↓</span></button>');
        if (isAdmin()) parts.push('<button class="pill pill-light" data-detail-act="edit">Szerkesztés <span class="pill-arrow">→</span></button>');
        el.innerHTML = parts.join('');
        el.style.display = parts.length ? 'flex' : 'none';

        el.onclick = (e) => {
            const btn = e.target.closest('[data-detail-act]');
            if (!btn) return;
            switch (btn.dataset.detailAct) {
                case 'download': window.open(t.downloadUrl, '_blank', 'noopener'); break;
                case 'magnet': this.openMagnet(t.id); break;
                case 'torrent': this.downloadTorrent(t.torrentFileId, t.torrentFileName); break;
                case 'edit': this.openEditModal(t.id); break;
            }
        };
    }

    closeDetail() {
        const id = this.currentDetailId;
        this.clearPlayers();
        this.currentDetailId = null;
        this.currentSeasons = null;
        UI.closeModal('detail-modal');
        if (id) this.refreshRowState(id);
        this.renderCounts();
        this.renderContinue();
    }

    /* A lejátszók leállítása — enélkül az iframe a bezárás után is szólna tovább */
    stopVideo(video) {
        if (!video) return;
        this.player?.detach();  // előbb elmenti, hol tartott a néző
        video.onerror = null;   // a leállítás ne indítsa el a tartalék lejátszót
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.style.display = 'none';
    }

    stopIframe(iframe) {
        if (!iframe) return;
        iframe.src = 'about:blank';
        iframe.removeAttribute('src');
        iframe.style.display = 'none';
    }

    clearPlayers() {
        this._playToken++;   // a még futó feloldások eredményét eldobjuk
        this.stopIframe(document.getElementById('cinema-player-iframe'));
        this.stopVideo(document.getElementById('cinema-player-video'));
    }

    playEmbed(url, ctx) {
        this.mountStream(url, {
            box: 'cinema-player-wrapper',
            iframe: 'cinema-player-iframe',
            video: 'cinema-player-video',
            placeholder: 'cinema-player-placeholder'
        }, ctx);
    }

    /* A saját lejátszónak: mit játszunk (a folytatás kulcsa), felirat, következő rész */
    playbackContext(item) {
        const t = this.currentTorrent;
        if (!t) return null;
        const ctx = { key: t.id, title: t.title, subtitles: t.subtitles || [] };
        const seasons = this.currentSeasons;
        if (!seasons || item.label?.startsWith('Trailer')) return ctx;

        const sIdx = this.currentSeasonIndex;
        const eIdx = this.currentEpisodeIndex;
        const season = seasons[sIdx];
        const ep = season?.episodes?.[eIdx];
        if (!ep) return ctx;

        ctx.key = `${t.id}:${sIdx}-${eIdx}`;
        ctx.title = `${t.title} · ${item.label}`;
        // Sorozatnál a felirat fájlneve (S01E02, 1x02, „Show - 05”) dönti el, melyik részhez tartozik.
        // Évad nélküli névnél egyévados sorozatban ez az évad, különben az 1. számít.
        ctx.subtitles = ctx.subtitles.filter(sub => {
            const info = subtitleEpisode(sub.name);
            if (info.episode !== Number(ep.ep)) return false;
            const s = info.season ?? (seasons.length === 1 ? Number(season.season) : 1);
            return s === Number(season.season);
        });

        const next = this.relativeEpisode(1);
        const prev = this.relativeEpisode(-1);
        if (next) {
            const n = seasons[next.s];
            ctx.nextLabel = `S${n.season}E${n.episodes[next.e].ep}`;
            ctx.onNext = () => this.playEpisode(next.s, next.e);
        }
        if (prev) ctx.onPrev = () => this.playEpisode(prev.s, prev.e);
        return ctx;
    }

    /* Betölti az URL-t a megadott lejátszóba: Streamtape esetén feloldva a
       natív <video>-ba, minden másnál (pl. YouTube) a beágyazott iframe-be. */
    mountStream(url, ids, ctx) {
        const box = document.getElementById(ids.box);
        const iframe = ids.iframe ? document.getElementById(ids.iframe) : null;
        const video = ids.video ? document.getElementById(ids.video) : null;
        const placeholder = ids.placeholder ? document.getElementById(ids.placeholder) : null;
        const token = ++this._playToken;

        this.stopVideo(video);
        if (placeholder) placeholder.style.display = 'none';

        const useIframe = () => {
            if (!iframe) return;
            // sandbox nem mehet rá: a Streamtape azt „Client blocked!” oldallal utasítja el
            iframe.src = this.embedUrl(url);
            iframe.style.display = 'block';
        };
        const fallback = (err) => {
            if (token !== this._playToken) return;
            console.warn('Stream feloldás sikertelen, marad a beágyazott lejátszó:', err);
            UI.toast('A reklámmentes lejátszás nem sikerült, beágyazott lejátszó indul.', 'info', 3000);
            useIframe();
        };

        // Backend nélkül nincs mit feloldani — felesleges kérés és hibaüzenet nélkül
        // megyünk a beágyazott lejátszóra.
        if (!video || !this.isStreamtape(url) || !hasBackend()) return useIframe();

        // Natív útvonal: az iframe-et leállítjuk, nehogy a háttérben szóljon.
        this.stopIframe(iframe);

        this.setStageLoading(box, true);
        this.resolveStream(url).then(proxyUrl => {
            if (token !== this._playToken) return;   // közben másik részre váltott
            // A feloldás sikerült, de a proxy mégsem ad videót (lejárt token, szerverhiba)
            video.onerror = () => {
                if (token !== this._playToken) return;
                const err = video.error;
                this._streamCache.delete(url);
                this.stopVideo(video);
                fallback(err);
            };
            this.player?.attach(ctx);
            video.src = proxyUrl;
            video.style.display = 'block';
            video.play().catch(() => {});            // autoplay tiltás esetén csendben marad
        }).catch(fallback).finally(() => {
            if (token === this._playToken) this.setStageLoading(box, false);
        });
    }

    /* ---- Sorozat ---- */
    renderSeriesPlayer(t) {
        const seasonTabs = document.getElementById('series-season-tabs');
        const list = document.getElementById('series-episode-list');
        const seasons = this.currentSeasons;
        if (!list || !seasons) return;

        const renderEps = (sIdx) => {
            const season = seasons[sIdx];
            if (!season) return;
            const w = this.watch[t.id] || { eps: {} };
            list.innerHTML = season.episodes.map((ep, i) => `
                <button class="ep ${sIdx === this.currentSeasonIndex && i === this.currentEpisodeIndex ? 'active' : ''} ${w.eps?.[`${sIdx}-${i}`] ? 'watched' : ''}" data-idx="${i}">
                    ${ep.ep}. rész
                </button>`).join('');
            list.querySelectorAll('.ep').forEach(btn =>
                btn.addEventListener('click', () => this.playEpisode(sIdx, parseInt(btn.dataset.idx, 10))));
            list.querySelector('.ep.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
        };
        this._renderEps = renderEps;

        if (seasonTabs) {
            if (seasons.length > 1) {
                seasonTabs.style.display = 'flex';
                seasonTabs.innerHTML = seasons.map((s, i) =>
                    `<button class="tab-link ${i === this.currentSeasonIndex ? 'active' : ''}" data-sidx="${i}">${s.season}. évad</button>`).join('');
                seasonTabs.querySelectorAll('.tab-link').forEach(btn =>
                    btn.addEventListener('click', () => this.playEpisode(parseInt(btn.dataset.sidx, 10), 0)));
            } else {
                seasonTabs.style.display = 'none';
                seasonTabs.innerHTML = '';
            }
        }

        const prev = document.getElementById('series-ep-prev');
        const next = document.getElementById('series-ep-next');
        if (prev) prev.onclick = () => list.scrollBy({ left: -260, behavior: 'smooth' });
        if (next) next.onclick = () => list.scrollBy({ left: 260, behavior: 'smooth' });

        let down = false, startX = 0, scrollStart = 0;
        list.onmousedown = (e) => { down = true; startX = e.pageX; scrollStart = list.scrollLeft; };
        list.onmouseleave = list.onmouseup = () => { down = false; };
        list.onmousemove = (e) => {
            if (!down) return;
            e.preventDefault();
            list.scrollLeft = scrollStart - (e.pageX - startX);
        };

        renderEps(this.currentSeasonIndex);
        this.updateNextEpisodeBtn();
    }

    playEpisode(sIdx, eIdx) {
        const seasons = this.currentSeasons;
        const t = this.currentTorrent;
        if (!seasons || !t) return;
        const season = seasons[sIdx];
        const ep = season?.episodes?.[eIdx];
        if (!ep) return;

        this.currentSeasonIndex = sIdx;
        this.currentEpisodeIndex = eIdx;
        this.markWatched(t.id, sIdx, eIdx);

        const trailers = this.currentMediaList.filter(m => m.label?.startsWith('Trailer'));
        this.currentMediaList = [{ label: `S${season.season}E${ep.ep}`, url: this.embedUrl(ep.url) }, ...trailers];
        this.currentMediaIndex = 0;

        this.renderMediaTabs();
        this.updateStage();
        this._renderEps?.(sIdx);
        this.updateNextEpisodeBtn();
        document.querySelectorAll('#series-season-tabs .tab-link').forEach((b, i) => b.classList.toggle('active', i === sIdx));
    }

    /* Az aktuálishoz képest delta-adik rész helye évadhatáron át, vagy null, ha nincs ilyen */
    relativeEpisode(delta) {
        const seasons = this.currentSeasons;
        if (!seasons) return null;
        let s = this.currentSeasonIndex;
        let e = this.currentEpisodeIndex + delta;

        while (e < 0) {
            s--;
            if (s < 0) return null;
            e += seasons[s].episodes.length;
        }
        while (e >= seasons[s].episodes.length) {
            e -= seasons[s].episodes.length;
            s++;
            if (s >= seasons.length) return null;
        }
        return { s, e };
    }

    playRelativeEpisode(delta) {
        if (!this.currentSeasons) return;
        const target = this.relativeEpisode(delta);
        if (!target) return UI.toast(delta < 0 ? 'Ez az első rész.' : 'Ez volt az utolsó rész.', 'info', 2000);
        this.playEpisode(target.s, target.e);
    }

    updateNextEpisodeBtn() {
        const btn = document.getElementById('next-episode-btn');
        if (!btn || !this.currentSeasons) return;
        btn.hidden = !this.relativeEpisode(1);
    }

    /* ============================================================
       LETÖLTÉS
       ============================================================ */
    async openMagnet(torrentId) {
        const torrent = this.torrents.find(t => t.id === torrentId);
        if (!torrent) return;
        let magnet = torrent.magnetLink || '';

        // A magnet.txt tartalmát csak akkor olvassuk be, ha a listázáskor még nem érkezett meg
        if (!magnet && torrent.magnetFileId) {
            UI.toast('Magnet beolvasása…', 'info', 1800);
            try {
                const text = await driveAPI.readTextFile(torrent.magnetFileId, torrent.title);
                if (text?.includes('magnet:?')) {
                    magnet = text.match(MAGNET_RE)?.[0] || text.trim();
                    torrent.magnetLink = magnet;
                }
            } catch (e) {
                console.error('Failed to fetch magnet:', e);
            }
        }

        if (!magnet.startsWith('magnet:?')) {
            return UI.toast('Nem található érvényes magnet link.', 'error');
        }
        window.location.href = withDisplayName(magnet, torrent.title);
        UI.toast('Magnet átadva a torrent kliensnek.', 'success', 2600);
    }

    downloadTorrent(fileId, fileName) {
        const a = document.createElement('a');
        a.href = `https://drive.google.com/uc?id=${fileId}&export=download`;
        a.download = fileName || 'download.torrent';
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        UI.toast('Torrent letöltése elindult.', 'success', 2400);
    }

    extractYouTubeId(url) {
        return url?.match(YOUTUBE_ID_RE)?.[1] || null;
    }

    /* ============================================================
       ADMIN ŰRLAP
       ============================================================ */
    openAddModal() {
        if (!isAdmin()) return;
        this.resetAddForm();
        UI.openModal('add-modal');
        setTimeout(() => document.getElementById('add-title')?.focus({ preventScroll: true }), 120);
    }

    bindDropZone() {
        const drop = document.getElementById('cover-drop-zone');
        const input = document.getElementById('cover-input');
        if (!drop || !input) return;

        const preview = (file) => { if (file) this.setCoverPreview(file); };

        ['dragover', 'dragenter'].forEach(ev =>
            drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag-over'); }));
        ['dragleave', 'dragend'].forEach(ev =>
            drop.addEventListener(ev, () => drop.classList.remove('drag-over')));

        drop.addEventListener('drop', (e) => {
            e.preventDefault();
            drop.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file?.type.startsWith('image/')) {
                input.files = e.dataTransfer.files;
                preview(file);
            }
        });
        drop.addEventListener('click', () => input.click());
        input.addEventListener('change', () => { if (input.files[0]) preview(input.files[0]); });
    }

    /* Borító előnézet: új fájl (File) vagy a meglévő borító URL-je; null = nincs.
       A fájlból készült ideiglenes URL-t felszabadítjuk, ha már nem kell. */
    setCoverPreview(source) {
        const box = document.getElementById('cover-preview');
        if (!box) return;
        if (this._coverObjectUrl) {
            URL.revokeObjectURL(this._coverObjectUrl);
            this._coverObjectUrl = null;
        }
        const img = box.querySelector('img');
        if (!source) {
            img.removeAttribute('src');
            box.hidden = true;
            return;
        }
        if (source instanceof Blob) this._coverObjectUrl = URL.createObjectURL(source);
        img.referrerPolicy = 'no-referrer';
        img.src = this._coverObjectUrl || source;
        box.hidden = false;
    }

    updateStreamFormByCategory() {
        const category = document.getElementById('add-category')?.value;
        const film = document.getElementById('film-stream-group');
        const series = document.getElementById('series-stream-group');
        const magyar = document.getElementById('magyar-group');

        if (magyar) magyar.style.display = (category === 'Film' || category === 'Sorozat') ? 'inline-flex' : 'none';
        // Játékhoz nem tartozik felirat, és részekre sem bontható
        const isGame = category === 'Játék';
        document.getElementById('subs-block')?.toggleAttribute('hidden', isGame);
        document.querySelectorAll('[data-no-game]').forEach(el => el.toggleAttribute('hidden', isGame));
        const streamField = document.getElementById('add-stream');
        if (streamField) {
            streamField.placeholder = isGame
                ? 'https://streamtape.com/v/…'
                : 'https://streamtape.com/v/… — vagy húzz ide egy .txt fájlt';
        }
        if (!film || !series) return;

        const streamInput = document.getElementById('add-stream');
        if (category === 'Sorozat') {
            film.style.display = 'none';
            series.style.display = 'block';
            const editor = document.getElementById('seasons-editor');
            if (editor && !editor.children.length) {
                // A filmként megadott link nem vész el: az 1. évad 1. része lesz
                const filmUrl = streamInput?.value.trim();
                this.addSeasonBlock(filmUrl ? [{ ep: 1, url: filmUrl }] : null, 1);
            }
        } else {
            film.style.display = 'block';
            series.style.display = 'none';
            // Visszafelé is: egyetlen részből film-link lesz, ha az még üres
            const seasons = this.collectSeasonsFromForm();
            if (streamInput && !streamInput.value.trim() && seasons.length === 1 && seasons[0].episodes.length === 1) {
                streamInput.value = seasons[0].episodes[0].url;
            }
        }
        // Sorozatnál a feliratokhoz évad és rész is tartozik
        this.renderSubtitleRows();
    }

    /* --- Streamtape linklista: bemásolt szöveg vagy .txt → évadok és részek (media-parse.js) --- */

    /* A felismert évadok betöltése a szerkesztőbe, összegzés a státuszsorban */
    applyParsedLinks(parsed, { notify = true } = {}) {
        if (!parsed.linkCount) {
            this.setBulkStatus('Nem található érvényes link a megadott szövegben.', true);
            if (notify) UI.toast('Nem található érvényes link.', 'error');
            return false;
        }

        const titleInput = document.getElementById('add-title');
        if (titleInput && !titleInput.value.trim() && parsed.title) titleInput.value = parsed.title;

        const editor = document.getElementById('seasons-editor');
        if (editor) editor.innerHTML = '';
        parsed.seasons.forEach(s => this.addSeasonBlock(s.episodes, s.season));

        const seasonCount = parsed.seasons.length;
        const notes = [];
        if (parsed.guessed) notes.push(`${parsed.guessed} rész száma a sorrendből`);
        if (parsed.duplicates) notes.push(`${parsed.duplicates} ismétlődő kihagyva`);
        if (parsed.ignored) notes.push(`${parsed.ignored} nem Streamtape link kihagyva`);
        const titleMsg = parsed.title ? ` (${parsed.title})` : '';
        this.setBulkStatus(`✅ Felismerve${titleMsg}: ${seasonCount} évad, ${parsed.linkCount} rész${notes.length ? ' · ' + notes.join(' · ') : ''}`);
        this.updateSeasonsSummaryBadge();

        if (notify) UI.toast(`Sikeres felismerés: ${seasonCount} évad, ${parsed.linkCount} rész betöltve!`, 'success');
        return true;
    }

    setBulkStatus(text, isError = false) {
        const statusEl = document.getElementById('bulk-parse-status');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = `bulk-status-badge${isError ? ' error' : ''}`;
        statusEl.style.display = text ? 'inline-block' : 'none';
    }

    handleBulkSeriesLinks(notify = true) {
        const textarea = document.getElementById('add-series-bulk-links');
        const clearBtn = document.getElementById('btn-clear-bulk-links');
        if (!textarea) return;

        const raw = textarea.value.trim();
        if (clearBtn) clearBtn.style.display = raw ? 'inline-block' : 'none';
        if (!raw) return this.setBulkStatus('');
        this.applyParsedLinks(parseStreamLinks(raw), { notify });
    }

    clearBulkSeriesLinks() {
        const textarea = document.getElementById('add-series-bulk-links');
        const clearBtn = document.getElementById('btn-clear-bulk-links');
        if (textarea) textarea.value = '';
        if (clearBtn) clearBtn.style.display = 'none';
        this.setBulkStatus('');
    }

    /**
     * .txt a Streamtape mezőbe: egy link → film, több link → sorozat, évadokra és részekre bontva.
     * Több linknél a kategória is Sorozatra vált.
     */
    async importStreamTxt(file) {
        if (!file) return;
        if (!/\.txt$/i.test(file.name) && file.type !== 'text/plain') {
            return UI.toast('Ide csak .txt fájl tölthető be.', 'error');
        }
        if (file.size > 2 * 1024 * 1024) return UI.toast('A .txt fájl túl nagy (legfeljebb 2 MB).', 'error');

        let text = '';
        try {
            text = decodeText(await file.arrayBuffer());
        } catch (e) {
            return UI.toast('A fájl nem olvasható.', 'error');
        }
        const parsed = parseStreamLinks(text);
        if (!parsed.linkCount) return UI.toast(`A(z) „${file.name}” fájlban nincs link.`, 'error');

        const categoryEl = document.getElementById('add-category');
        const titleInput = document.getElementById('add-title');

        // Játék nem bontható részekre — ott legfeljebb egy (pl. gameplay) link lehet
        if (categoryEl.value === 'Játék' && parsed.linkCount > 1) {
            return UI.toast('Játékhoz csak egy link tartozhat, a fájlban több van.', 'error', 4200);
        }

        // Egyetlen link, és nem sorozatot szerkesztünk: film
        if (parsed.linkCount === 1 && categoryEl.value !== 'Sorozat') {
            const ep = parsed.seasons[0].episodes[0];
            document.getElementById('add-stream').value = ep.url;
            if (titleInput && !titleInput.value.trim()) titleInput.value = guessTitle(ep.name) || parsed.title || '';
            if (!categoryEl.value) {
                categoryEl.value = 'Film';
                this.updateStreamFormByCategory();
            }
            return UI.toast(`Link betöltve — ${file.name}`, 'success');
        }

        if (categoryEl.value !== 'Sorozat') {
            categoryEl.value = 'Sorozat';
            this.updateStreamFormByCategory();
            UI.toast('Több link van a fájlban — a kategória Sorozatra váltott.', 'info', 3400);
        }
        const textarea = document.getElementById('add-series-bulk-links');
        if (textarea) textarea.value = text.trim();
        const clearBtn = document.getElementById('btn-clear-bulk-links');
        if (clearBtn) clearBtn.style.display = 'inline-block';
        this.applyParsedLinks(parsed);
    }

    /* Fájl ráhúzása egy mezőre: kiemelés húzás közben, a fájlok átadása ejtéskor.
       Sima szöveg ráhúzása továbbra is a mezőbe kerül. */
    bindFileDrop(zone, onFiles) {
        const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
        ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            zone.classList.add('drag-over');
        }));
        zone.addEventListener('dragleave', (e) => {
            if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
        });
        zone.addEventListener('drop', (e) => {
            zone.classList.remove('drag-over');
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            onFiles(e.dataTransfer.files);
        });
    }

    syncTorrentPicker() {
        const file = document.getElementById('torrent-input')?.files?.[0];
        const current = this._editOriginal?.torrentFileName;
        const nameEl = document.getElementById('torrent-name');
        if (nameEl) {
            nameEl.textContent = file ? file.name : (current ? `Jelenlegi: ${current}` : 'Nincs kiválasztva');
            nameEl.classList.toggle('is-set', !!file);
        }
        const clear = document.getElementById('torrent-clear');
        if (clear) clear.hidden = !file;
    }

    /* ============================================================
       FELIRATOK (űrlap)
       ============================================================ */

    /* Az évadszerkesztőben lévő, linkkel rendelkező részek: [{ season, eps: Set }] */
    formEpisodeIndex() {
        return this.collectSeasonsFromForm().map(s => ({ season: s.season, eps: new Set(s.episodes.map(e => e.ep)) }));
    }

    /* A fájlnévből hiányzó évadot / részt az űrlapon lévő részek alapján egészíti ki */
    placeSubtitle({ season, episode }, index) {
        let s = season;
        let e = episode;
        if (e === null && index.length === 1 && index[0].eps.size === 1) {
            // Egyetlen rész van: a felirat csak ahhoz tartozhat
            s = index[0].season;
            e = [...index[0].eps][0];
        }
        if (e !== null && s === null) {
            const holders = index.filter(x => x.eps.has(e));
            s = holders.length === 1 ? holders[0].season : (index.length === 1 ? index[0].season : 1);
        }
        return { season: s, episode: e };
    }

    async addSubtitleFiles(fileList) {
        const all = [...(fileList || [])];
        const files = all.filter(f => SUB_EXT_RE.test(f.name));
        const problems = [];
        // Ha a Converter kimeneti mappájából mindent ráhúznak, a videókat nem soroljuk fel egyenként
        const others = all.filter(f => !SUB_EXT_RE.test(f.name));
        if (others.length) problems.push(others.length === 1 ? `${others[0].name}: nem felirat` : `${others.length} nem feliratfájl`);
        const index = this.formEpisodeIndex();
        const added = [];

        for (const file of files) {
            if (file.size > 5 * 1024 * 1024) {
                problems.push(`${file.name}: túl nagy`);
                continue;
            }
            let text = '';
            try {
                text = decodeText(await file.arrayBuffer());
            } catch (e) {
                problems.push(`${file.name}: nem olvasható`);
                continue;
            }
            const ext = file.name.match(SUB_EXT_RE)[1].toLowerCase();
            const content = (ext === 'ass' || ext === 'ssa') ? assToSrt(text) : text;
            if (!content.includes('-->')) {
                problems.push(`${file.name}: nincs benne időzített szöveg`);
                continue;
            }

            const byName = subtitleNameInfo(file.name);
            const byText = byName.lang ? null : detectTextLanguage(content);
            const row = {
                uid: ++this._subUid,
                kind: 'new',
                origName: file.name,
                content,
                ext: ext === 'vtt' ? 'vtt' : 'srt',
                lang: byName.lang || byText || SUB_LANG_UNKNOWN,
                langSource: byName.lang ? 'fájlnévből' : (byText ? 'a szövegből' : ''),
                forced: byName.forced,
                sdh: byName.sdh,
                ...this.placeSubtitle(subtitleEpisode(file.name), index)
            };
            this.subsDraft.push(row);
            added.push(row);
        }

        this.renderSubtitleRows();

        if (added.length) {
            const byLang = new Map();
            added.forEach(r => byLang.set(r.lang, (byLang.get(r.lang) || 0) + 1));
            const langs = [...byLang.entries()].map(([code, n]) =>
                `${n} ${code === SUB_LANG_UNKNOWN ? 'ismeretlen nyelvű' : langLabel(code).toLowerCase()}`);
            UI.toast(`${added.length} felirat hozzáadva — ${langs.join(', ')}`, 'success');
        }
        if (problems.length) UI.toast(`Kihagyva: ${problems.join('; ')}`, 'error', 5200);
    }

    /* Szerkesztéskor a mappában lévő feliratok — ezek törölhetők, javíthatók */
    loadExistingSubtitles(t) {
        const index = this.formEpisodeIndex();
        this.subsDraft = (t.subtitles || []).map(sub => {
            const info = subtitleNameInfo(sub.name);
            return {
                uid: ++this._subUid,
                kind: 'existing',
                id: sub.id,
                name: sub.name,
                origName: sub.name,
                ext: (sub.name.match(/\.(srt|vtt)$/i)?.[1] || 'srt').toLowerCase(),
                lang: info.lang || SUB_LANG_UNKNOWN,
                langSource: '',
                forced: info.forced,
                sdh: info.sdh,
                ...this.placeSubtitle(subtitleEpisode(sub.name), index)
            };
        });
        this.renderSubtitleRows();
    }

    subtitleRowOf(el) {
        const uid = Number(el?.closest('.sub-row')?.dataset.uid);
        return this.subsDraft.find(r => r.uid === uid) || null;
    }

    bindSubtitleList() {
        const list = document.getElementById('subs-list');
        if (!list) return;

        list.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-sub-act]');
            const row = btn && this.subtitleRowOf(btn);
            if (!row) return;
            if (btn.dataset.subAct === 'drop') {
                this.subsDraft = this.subsDraft.filter(r => r !== row);
                return this.renderSubtitleRows();
            }
            if (btn.dataset.subAct === 'toggle') row.remove = !row.remove;
            if (btn.dataset.subAct === 'keep') row.keepBoth = true;
            this.refreshSubtitleStates();
        });

        const onEdit = (e) => {
            const row = this.subtitleRowOf(e.target);
            if (!row) return;
            const num = (v) => (v === '' ? null : toCount(v, null));
            if (e.target.matches('.sub-lang')) row.lang = e.target.value;
            else if (e.target.matches('.sub-season')) row.season = num(e.target.value);
            else if (e.target.matches('.sub-episode')) row.episode = num(e.target.value);
            else return;
            row.dirty = true;
            row.langSource = e.target.matches('.sub-lang') ? '' : row.langSource;
            this.refreshSubtitleStates();
        };
        list.addEventListener('input', onEdit);
        list.addEventListener('change', onEdit);
    }

    renderSubtitleRows() {
        const list = document.getElementById('subs-list');
        if (!list) return;
        const isSeries = document.getElementById('add-category')?.value === 'Sorozat';
        const langs = [...SUB_LANGUAGES.map(l => [l.code, l.label]), [SUB_LANG_UNKNOWN, 'Ismeretlen nyelv']];

        list.innerHTML = this.subsDraft.map(r => `
            <div class="sub-row${r.kind === 'existing' ? ' is-existing' : ''}" data-uid="${r.uid}">
                <div class="sub-main">
                    <span class="sub-name" title="${esc(r.origName)}">${esc(r.origName)}</span>
                    <span class="sub-meta"></span>
                </div>
                <div class="sub-controls">
                    ${isSeries ? `
                    <label class="sub-num" title="Évad"><span>É</span><input type="number" class="sub-season" min="0" max="99" value="${r.season ?? ''}" aria-label="Évad"></label>
                    <label class="sub-num" title="Rész"><span>R</span><input type="number" class="sub-episode" min="0" max="9999" value="${r.episode ?? ''}" aria-label="Rész"></label>` : ''}
                    <select class="sub-lang" aria-label="Nyelv">${langs.map(([code, label]) =>
                        `<option value="${code}"${code === r.lang ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>
                    <span class="sub-state"></span>
                    <button type="button" class="icon-x" data-sub-act="${r.kind === 'existing' ? 'toggle' : 'drop'}"></button>
                </div>
            </div>`).join('');
        this.refreshSubtitleStates();
    }

    /**
     * Végleges fájlnevek: S01E02.hu.srt (filmnél felirat.hu.srt), azonos nyelvnél S01E02.2.hu.srt.
     * Ha egy új felirat ugyanarra a részre és nyelvre szól, mint egy meglévő, az előbbi lecseréli
     * az utóbbit (hacsak nem kérik, hogy mindkettő maradjon).
     */
    computeSubtitleTargets() {
        const isSeries = document.getElementById('add-category')?.value === 'Sorozat';
        const rows = this.subsDraft;
        const keyOf = (r) => [isSeries ? r.season : '', isSeries ? r.episode : '', r.lang, r.forced ? 1 : 0, r.sdh ? 1 : 0].join('|');
        const newKeys = new Set(rows.filter(r => r.kind === 'new').map(keyOf));
        rows.forEach(r => {
            r.replaced = r.kind === 'existing' && !r.remove && !r.keepBoth && newKeys.has(keyOf(r));
        });

        const kept = rows.filter(r => !(r.kind === 'existing' && (r.remove || r.replaced)));
        const untouched = (r) => r.kind === 'existing' && !r.dirty;
        const taken = new Set(kept.filter(untouched).map(r => r.name.toLowerCase()));
        const counts = new Map();
        kept.filter(untouched).forEach(r => {
            r.target = r.name;
            counts.set(keyOf(r), (counts.get(keyOf(r)) || 0) + 1);
        });
        kept.filter(r => !untouched(r)).forEach(r => {
            const key = keyOf(r);
            let dup = (counts.get(key) || 0) + 1;
            let name = '';
            for (;; dup++) {
                name = subtitleDriveName({
                    season: isSeries ? r.season : null,
                    episode: isSeries ? r.episode : null,
                    lang: r.lang, forced: r.forced, sdh: r.sdh, ext: r.ext, dup
                });
                if (!taken.has(name.toLowerCase())) break;
            }
            counts.set(key, dup);
            taken.add(name.toLowerCase());
            r.target = name;
        });
        rows.filter(r => !kept.includes(r)).forEach(r => { r.target = ''; });
    }

    refreshSubtitleStates() {
        const list = document.getElementById('subs-list');
        if (!list) return;
        list.hidden = !this.subsDraft.length;
        if (!this.subsDraft.length) return;

        const isSeries = document.getElementById('add-category')?.value === 'Sorozat';
        const index = isSeries ? this.formEpisodeIndex() : [];
        this.computeSubtitleTargets();

        this.subsDraft.forEach(r => {
            const row = list.querySelector(`.sub-row[data-uid="${r.uid}"]`);
            if (!row) return;
            const gone = r.kind === 'existing' && (r.remove || r.replaced);

            let state = '✓';
            let tone = 'ok';
            if (r.remove) [state, tone] = ['törlődik', 'bad'];
            else if (r.replaced) [state, tone] = ['lecserélődik', 'warn'];
            else if (isSeries && (r.season == null || r.episode == null)) [state, tone] = ['melyik rész?', 'bad'];
            else if (isSeries && !index.some(x => x.season === r.season && x.eps.has(r.episode))) [state, tone] = ['nincs ilyen rész', 'warn'];
            else if (isSeries) state = `S${pad2(r.season)}E${pad2(r.episode)} ✓`;

            const stateEl = row.querySelector('.sub-state');
            stateEl.textContent = state;
            stateEl.dataset.tone = tone;
            row.classList.toggle('is-gone', gone);

            const meta = [];
            if (!gone && r.target) meta.push(esc(r.target === r.origName ? 'marad így' : `→ ${r.target}`));
            if (r.langSource) meta.push(`nyelv ${esc(r.langSource)}`);
            else if (r.kind === 'new' && r.lang === SUB_LANG_UNKNOWN) meta.push('a nyelvet nem sikerült felismerni');
            if (r.forced) meta.push('forced');
            if (r.sdh) meta.push('SDH');
            if (r.replaced) meta.push('<button type="button" class="link-quiet" data-sub-act="keep">mindkettő maradjon</button>');
            row.querySelector('.sub-meta').innerHTML = meta.join(' · ');

            const btn = row.querySelector('[data-sub-act="toggle"], [data-sub-act="drop"]');
            if (btn) {
                const restore = r.kind === 'existing' && r.remove;
                btn.textContent = restore ? '↺' : '✕';
                btn.title = restore ? 'Visszaállítás' : (r.kind === 'existing' ? 'Törlés a Drive-ról' : 'Eltávolítás');
            }
        });
    }

    /* Mentési terv a drive.syncSubtitles számára */
    subtitlePlan() {
        this.computeSubtitleTargets();
        const rows = this.subsDraft;
        const typeOf = (ext) => (ext === 'vtt' ? 'text/vtt' : 'application/x-subrip');
        return {
            remove: rows.filter(r => r.kind === 'existing' && (r.remove || r.replaced)).map(r => ({ id: r.id, name: r.name })),
            rename: rows.filter(r => r.kind === 'existing' && r.target && r.target !== r.name).map(r => ({ id: r.id, name: r.target })),
            upload: rows.filter(r => r.kind === 'new' && r.target)
                .map(r => ({ name: r.target, file: new File([r.content], r.target, { type: typeOf(r.ext) }) }))
        };
    }

    /* ============================================================
       ÉVADSZERKESZTŐ
       ============================================================ */

    updateSeasonsSummaryBadge() {
        const badge = document.getElementById('seasons-summary-badge');
        const blocks = document.querySelectorAll('#seasons-editor .season-block');
        if (badge) {
            if (!blocks.length) {
                badge.style.display = 'none';
            } else {
                let totalEps = 0;
                blocks.forEach(b => { totalEps += b.querySelectorAll('.ep-row').length; });
                badge.textContent = `${blocks.length} évad · ${totalEps} rész`;
                badge.style.display = 'inline-block';
            }
        }
        // A feliratok „nincs ilyen rész” jelzése a szerkesztővel együtt frissül
        if (this.subsDraft.length) this.refreshSubtitleStates();
    }

    /* Az évad és a rész száma szerkeszthető; törléskor a többi száma NEM változik,
       így a felismert S01E05-ből sem lesz csendben S01E04. */
    addSeasonBlock(episodes = null, seasonNum = null) {
        const editor = document.getElementById('seasons-editor');
        if (!editor) return;
        const used = [...editor.querySelectorAll('.season-num')].map(i => toCount(i.value, 0));
        const sNum = seasonNum ?? (used.length ? Math.max(...used) + 1 : 1);

        const block = document.createElement('div');
        block.className = 'season-block';
        block.innerHTML = `
            <div class="season-head">
                <label class="season-label">
                    <input type="number" class="season-num" min="0" max="99" value="${sNum}" aria-label="Évad száma">
                    <span class="label">. évad</span>
                </label>
                <button type="button" class="icon-x btn-remove-season" title="Évad törlése">✕</button>
            </div>
            <div class="episodes-editor"></div>
            <button type="button" class="link-quiet btn-add-ep">+ rész hozzáadása</button>`;
        editor.appendChild(block);

        const list = block.querySelector('.episodes-editor');
        if (episodes?.length) {
            episodes.forEach((ep, i) => this.addEpisodeRow(list, ep.url, ep.ep ?? (i + 1)));
        } else {
            this.addEpisodeRow(list);
        }

        block.querySelector('.btn-remove-season').addEventListener('click', () => {
            block.remove();
            this.updateSeasonsSummaryBadge();
        });
        block.querySelector('.btn-add-ep').addEventListener('click', () => {
            this.addEpisodeRow(list)?.querySelector('.ep-url')?.focus();
        });
        block.querySelector('.season-num').addEventListener('input', () => this.updateSeasonsSummaryBadge());
        this.updateSeasonsSummaryBadge();
    }

    addEpisodeRow(listEl, url = '', epNum = null) {
        if (!listEl) return null;
        const used = [...listEl.querySelectorAll('.ep-num')].map(i => toCount(i.value, 0));
        const eNum = epNum ?? (used.length ? Math.max(...used) + 1 : 1);

        const row = document.createElement('div');
        row.className = 'ep-row';
        row.innerHTML = `
            <input type="number" class="ep-num" min="0" max="9999" value="${esc(eNum)}" aria-label="Rész száma">
            <input type="text" class="ep-url" placeholder="https://streamtape.com/v/…" value="${esc(url)}">
            <button type="button" class="icon-x btn-remove-ep" title="Törlés">✕</button>`;
        listEl.appendChild(row);

        row.querySelector('.btn-remove-ep').addEventListener('click', () => {
            row.remove();
            this.updateSeasonsSummaryBadge();
        });
        row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => this.updateSeasonsSummaryBadge()));
        this.updateSeasonsSummaryBadge();
        return row;
    }

    /* Az azonos számú évadblokkok összeolvadnak, minden számsorrendbe kerül */
    collectSeasonsFromForm() {
        const bySeason = new Map();
        document.querySelectorAll('#seasons-editor .season-block').forEach((block, sIdx) => {
            const seasonNum = toCount(block.querySelector('.season-num')?.value, sIdx + 1);
            const episodes = bySeason.get(seasonNum) || [];
            block.querySelectorAll('.ep-row').forEach((row, eIdx) => {
                const url = (row.querySelector('.ep-url')?.value || '').trim();
                if (url) episodes.push({ ep: toCount(row.querySelector('.ep-num')?.value, eIdx + 1), url });
            });
            if (episodes.length) bySeason.set(seasonNum, episodes);
        });
        return [...bySeason.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([season, episodes]) => ({ season, episodes: episodes.sort((a, b) => a.ep - b.ep) }));
    }

    /* „2. évad 3. rész” — ami kétszer szerepel a szerkesztőben */
    duplicateEpisodes(seasons) {
        const dupes = [];
        seasons.forEach(s => {
            const seen = new Set();
            s.episodes.forEach(e => {
                if (seen.has(e.ep)) dupes.push(`${s.season}. évad ${e.ep}. rész`);
                seen.add(e.ep);
            });
        });
        return dupes;
    }

    resetAddForm() {
        document.getElementById('add-form')?.reset();
        document.getElementById('edit-torrent-id').value = '';
        this._editOriginal = null;
        this.setText('add-modal-title', 'Új tartalom');
        this.setText('add-submit-text', 'Feltöltés');
        const editor = document.getElementById('seasons-editor');
        if (editor) editor.innerHTML = '';
        this.setCoverPreview(null);
        const desc = document.getElementById('add-description');
        if (desc) desc.disabled = false;
        this.subsDraft = [];
        this.clearBulkSeriesLinks();
        this.updateStreamFormByCategory();
        this.updateSeasonsSummaryBadge();
        this.syncTorrentPicker();
    }

    openEditModal(torrentId) {
        const t = this.torrents.find(x => x.id === torrentId);
        if (!t || !isAdmin()) return;

        // A részletek nézetből nyitva a lejátszót is le kell állítani, különben tovább szól
        if (document.getElementById('detail-modal')?.classList.contains('active')) this.closeDetail();

        this.resetAddForm();
        document.getElementById('edit-torrent-id').value = torrentId;
        this.setText('add-modal-title', `Szerkesztés — ${t.title}`);
        this.setText('add-submit-text', 'Mentés');

        // Amit a felhasználó kiürít, az a Drive-ról is törlődik — ehhez kell a kiinduló állapot
        this._editOriginal = {
            magnetLink: t.magnetLink || '',
            downloadUrl: t.downloadUrl || '',
            description: t.description || '',
            descriptionCut: !!t.descriptionCut,
            trailers: !!t.trailers?.length,
            streamUrl: t.streamUrl || '',
            hasSeasons: this.playableInfo(t).epCount > 0,
            torrentFileName: t.torrentFileName || ''
        };

        document.getElementById('add-title').value = t.title || '';
        document.getElementById('add-category').value = t.category || '';
        document.getElementById('add-magnet').value = t.magnetLink || '';
        document.getElementById('add-download').value = t.downloadUrl || '';
        document.getElementById('add-description').value = t.description || '';
        document.getElementById('add-trailers').value = (t.trailers || []).join('\n');
        const magyarEl = document.getElementById('add-magyar');
        if (magyarEl) magyarEl.checked = !!t.isMagyar;
        if (t.coverUrl) this.setCoverPreview(this.thumb(t.coverUrl, 800));

        this.updateStreamFormByCategory();

        this.clearBulkSeriesLinks();
        if (t.category === 'Sorozat') {
            const editor = document.getElementById('seasons-editor');
            if (editor) editor.innerHTML = '';
            if (t.seasons?.length) t.seasons.forEach((s, idx) => this.addSeasonBlock(s.episodes, s.season ?? (idx + 1)));
            else if (t.episodes?.length) this.addSeasonBlock(t.episodes, 1);
            else this.addSeasonBlock(null, 1);
            this.updateSeasonsSummaryBadge();
        } else if (t.streamUrl) {
            document.getElementById('add-stream').value = t.streamUrl;
        }

        this.loadExistingSubtitles(t);
        this.syncTorrentPicker();
        this.loadFullDescription(t);

        UI.openModal('add-modal');
    }

    /* A gyorsítótárban a leírás 600 karakterre van vágva — szerkesztéshez a teljes szöveg kell,
       különben a mentés a csonka változatot írná vissza. */
    loadFullDescription(t) {
        const descEl = document.getElementById('add-description');
        if (!descEl || !t.descriptionFileId || (t.description && !t.descriptionCut)) return;

        const placeholder = descEl.placeholder;
        descEl.disabled = true;
        descEl.placeholder = 'Leírás betöltése…';
        driveAPI.readTextFile(t.descriptionFileId, t.title).then(text => {
            if (!text?.trim() || document.getElementById('edit-torrent-id').value !== t.id) return;
            t.description = text.trim();
            delete t.descriptionCut;
            descEl.value = t.description;
            if (this._editOriginal) Object.assign(this._editOriginal, { description: t.description, descriptionCut: false });
        }).catch(() => {}).finally(() => {
            descEl.disabled = false;
            descEl.placeholder = placeholder;
        });
    }

    async handleAddTorrent() {
        const editId = document.getElementById('edit-torrent-id')?.value || '';
        const title = document.getElementById('add-title').value.trim();
        const category = document.getElementById('add-category').value;
        const magnetLink = document.getElementById('add-magnet').value.trim();
        const streamUrl = document.getElementById('add-stream')?.value.trim() || '';
        const downloadUrl = document.getElementById('add-download')?.value.trim() || '';
        const trailersRaw = document.getElementById('add-trailers')?.value.trim() || '';
        const trailers = trailersRaw ? trailersRaw.split('\n').map(u => u.trim()).filter(Boolean) : [];
        const coverFile = document.getElementById('cover-input').files[0];
        const torrentFile = document.getElementById('torrent-input').files[0];
        let description = document.getElementById('add-description').value.trim();
        const isMagyar = (category === 'Film' || category === 'Sorozat') && !!document.getElementById('add-magyar')?.checked;
        const isSeries = category === 'Sorozat';
        const seasons = isSeries ? this.collectSeasonsFromForm() : null;

        if (!title || !category) return UI.toast('A cím és a kategória kötelező.', 'error');

        if (category === 'Játék' && this.subsDraft.some(r => r.kind === 'new')) {
            UI.toast('Játékhoz nem tartozik felirat — a hozzáadott feliratok nem töltődnek fel.', 'info', 4200);
        }

        const dupes = isSeries ? this.duplicateEpisodes(seasons) : [];
        if (dupes.length) return UI.toast(`Kétszer szerepel: ${dupes.slice(0, 3).join(', ')}${dupes.length > 3 ? '…' : ''}`, 'error', 5000);

        if (isSeries) {
            const unplaced = this.subsDraft.filter(r =>
                (r.kind === 'new' || (r.dirty && !r.remove)) && (r.season == null || r.episode == null));
            if (unplaced.length) return UI.toast(`${unplaced.length} feliratnál add meg, melyik részhez tartozik.`, 'error', 4200);
        }

        // Szerkesztés: a kiürített mezők fájljai törlődnek (de csak ha tényleg volt bennük valami)
        const orig = this._editOriginal || {};
        const clear = [];
        if (editId) {
            // A betöltetlen, csonka leírást nem írjuk vissza
            if (orig.descriptionCut && description === orig.description.trim()) description = '';
            else if (orig.description && !description) clear.push('description');
            if (orig.magnetLink && !magnetLink) clear.push('magnet');
            if (orig.downloadUrl && !downloadUrl) clear.push('download');
            if (orig.trailers && !trailers.length) clear.push('trailers');
            if (orig.streamUrl && (isSeries || !streamUrl)) clear.push('stream');
            if (orig.hasSeasons && (!isSeries || !seasons.length)) clear.push('episodes');
        }

        const btn = document.getElementById('add-submit-btn');
        btn.disabled = true;
        this.setText('add-submit-text', editId ? 'Mentés…' : 'Feltöltés…');
        UI.progress(true);

        try {
            const payload = {
                title, category, coverFile, magnetLink, torrentFile, description,
                streamUrl: isSeries ? '' : streamUrl,
                downloadUrl, trailers, seasons, isMagyar,
                // Játéknál a (rejtett) feliratblokkhoz nem nyúlunk
                subtitlePlan: this.subsDraft.length && category !== 'Játék' ? this.subtitlePlan() : null
            };
            if (editId) {
                await driveAPI.updateTorrent(editId, { ...payload, clear });
                UI.toast('Mentve.', 'success');
            } else {
                await driveAPI.addTorrent(payload);
                UI.toast('Új tartalom hozzáadva.', 'success');
            }
            UI.closeModal('add-modal');
            this.resetAddForm();
            await this.loadTorrents({ silent: true });
        } catch (error) {
            console.error('Add/edit error:', error);
            UI.toast(error.message || 'Hiba a mentés közben.', 'error', 5000);
        } finally {
            btn.disabled = false;
            this.setText('add-submit-text', editId ? 'Mentés' : 'Feltöltés');
            UI.progress(false);
        }
    }

    async confirmDelete(torrentId, title) {
        const ok = await UI.confirm({
            title: 'Tartalom törlése',
            text: `A(z) „${title}” mappa és minden fájlja véglegesen törlődik a Google Drive-ról.`,
            okLabel: 'Végleges törlés',
            kicker: 'Törlés'
        });
        if (!ok) return;
        try {
            UI.progress(true);
            await driveAPI.deleteTorrent(torrentId);
            UI.toast('Törölve.', 'success');
            await this.loadTorrents({ silent: true });
        } catch (error) {
            console.error('Delete error:', error);
            UI.toast('A törlés nem sikerült.', 'error');
        } finally {
            UI.progress(false);
        }
    }

    /* ============================================================
       BELÉPÉSI KÓDOK
       ============================================================ */
    renderPasscodeList() {
        const listEl = document.getElementById('passcode-list');
        if (!listEl) return;
        const passcodes = getPasscodes();

        if (!passcodes.length) {
            listEl.innerHTML = `<p class="state-text">Még nincs mentett kód.</p>`;
            return;
        }
        listEl.innerHTML = passcodes.map(p => `
            <div class="code-item" data-id="${esc(p.id)}">
                <span class="code-name">${esc(p.name)}</span>
                <div class="tile-meta">
                    <button class="code-value" data-pc-act="copy" title="Másolás">${esc(p.code)}</button>
                    <button class="link-quiet" data-pc-act="delete">törlés</button>
                </div>
            </div>`).join('');

        listEl.onclick = (e) => {
            const btn = e.target.closest('[data-pc-act]');
            if (!btn) return;
            const row = btn.closest('.code-item');
            if (btn.dataset.pcAct === 'copy') this.copyCode(row.querySelector('.code-value').textContent.trim());
            else this.handleDeletePasscode(row.dataset.id);
        };
    }

    copyCode(code) {
        navigator.clipboard?.writeText(code)
            .then(() => UI.toast(`Vágólapra másolva — ${code}`, 'success', 2200))
            .catch(() => UI.toast('A másolás nem sikerült.', 'error'));
    }

    async handleDeletePasscode(id) {
        const ok = await UI.confirm({
            title: 'Kód törlése',
            text: 'Ezzel a kóddal többé nem lehet belépni.',
            okLabel: 'Törlés', kicker: 'Belépési kód'
        });
        if (!ok) return;
        deletePasscode(id);
        UI.toast('Kód törölve.', 'success');
        this.renderPasscodeList();
        await this.uploadPasscodesToDrive();
    }

    async syncPasscodesFromDrive() {
        if (!CONFIG.GOOGLE_API_KEY || !CONFIG.DRIVE_ROOT_FOLDER_ID) return;
        try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 3000);
            const url = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_ROOT_FOLDER_ID}'+in+parents+and+name='passcodes.json'+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id,description)`;
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(tid);
            if (!res.ok) return;
            const data = await res.json();
            const desc = data.files?.[0]?.description;
            if (desc && desc.trim().startsWith('[')) {
                const passcodes = JSON.parse(desc.trim());
                if (Array.isArray(passcodes) && passcodes.length) {
                    localStorage.setItem('denjit_passcodes', JSON.stringify(passcodes));
                }
            }
        } catch (e) {
            console.log('Passcode sync skipped:', e.message);
        }
    }

    async uploadPasscodesToDrive() {
        if (!isAdmin()) return;
        try {
            const content = JSON.stringify(getPasscodes());
            const token = await driveAPI.getAccessToken();
            const searchUrl = `https://www.googleapis.com/drive/v3/files?q='${CONFIG.DRIVE_ROOT_FOLDER_ID}'+in+parents+and+name='passcodes.json'+and+trashed=false&key=${CONFIG.GOOGLE_API_KEY}&fields=files(id)`;
            const searchRes = await fetch(searchUrl);
            const searchData = await searchRes.json();
            const existing = searchData.files || [];

            if (existing.length) {
                await fetch(`https://www.googleapis.com/drive/v3/files/${existing[0].id}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ description: content })
                });
            } else {
                await driveAPI.uploadTextFile(content, CONFIG.DRIVE_ROOT_FOLDER_ID, 'passcodes.json', content);
            }
            UI.toast('Kódok szinkronizálva a Drive-ra.', 'success');
        } catch (e) {
            console.error('Failed to upload passcodes:', e);
            UI.toast('A Drive szinkronizálás nem sikerült.', 'error');
        }
    }
}

const app = new App();
window.app = app;
document.addEventListener('DOMContentLoaded', () => app.init());
