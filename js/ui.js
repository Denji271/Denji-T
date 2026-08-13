/**
 * Denji-T · UI layer
 * Tárolás, beállítások, toast, megerősítés, takeover-kezelés.
 */

/* ---------------- Storage ---------------- */
const Store = {
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            console.warn('Store write failed:', key, e);
        }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    }
};

/* ---------------- Helpers ---------------- */
const esc = (str) => String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[m]));

const debounce = (fn, ms = 160) => {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
};

function formatDate(iso, long = false) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return long
        ? d.toLocaleDateString('hu-HU', { year: 'numeric', month: 'long', day: 'numeric' })
        : d.toLocaleDateString('hu-HU');
}

function yearOf(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : String(d.getFullYear());
}

function timeAgo(ts) {
    if (!ts) return '';
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'az imént';
    if (min < 60) return `${min} perce`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs} órája`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days} napja`;
    return formatDate(new Date(ts).toISOString());
}

/* ---------------- Preferences ---------------- */
const Prefs = {
    key: 'denjit_prefs_v4',
    // A megjelenés rögzített: papír kontraszt, teljes mozgás. Csak az elrendezés választható.
    fixed: { invert: 'off', motion: 'full' },
    defaults: { layout: 'index' },
    data: {},

    load() {
        this.data = Object.assign({}, this.defaults, Store.get(this.key, {}));
        this.apply();
        return this.data;
    },
    get(key) { return this.fixed[key] ?? this.data[key] ?? this.defaults[key]; },
    set(key, value) {
        if (key in this.fixed) return;
        this.data[key] = value;
        Store.set(this.key, this.data);
        this.apply();
    },
    apply() {
        const html = document.documentElement;
        html.dataset.invert = this.fixed.invert;
        html.dataset.motion = this.fixed.motion;

        const list = document.getElementById('torrent-grid');
        if (list) list.dataset.layout = 'index';
    }
};

/* ---------------- UI ---------------- */
const UI = {
    _open: 0,
    _lastFocus: null,

    /* --- Toast --- */
    toast(message, type = 'info', timeout = 3600) {
        const container = document.getElementById('toast-container');
        if (!container) return;

        const marks = { success: 'kész', error: 'hiba', info: 'infó', warning: 'figyelem' };
        const el = document.createElement('div');
        el.className = `toast toast-${type}`;
        el.innerHTML = `<span class="toast-mark">${marks[type] || marks.info}</span><span>${esc(message)}</span>`;
        el.addEventListener('click', () => this._dismiss(el));
        container.appendChild(el);
        setTimeout(() => this._dismiss(el), timeout);
        return el;
    },
    _dismiss(el) {
        if (!el || el.dataset.gone) return;
        el.dataset.gone = '1';
        el.classList.add('toast-exit');
        setTimeout(() => el.remove(), 500);
    },

    /* --- Takeover / sheet --- */
    openModal(idOrEl) {
        const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
        if (!el || el.classList.contains('active')) return;
        this._lastFocus = document.activeElement;
        el.classList.add('active');
        el.scrollTop = 0;
        this._open++;
        document.body.style.overflow = 'hidden';
        document.dispatchEvent(new CustomEvent('ui:overlay', { detail: { open: true, count: this._open } }));
    },
    closeModal(idOrEl) {
        const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
        if (!el || !el.classList.contains('active')) return;
        el.classList.remove('active');
        this._open = Math.max(0, this._open - 1);
        if (this._open === 0) document.body.style.overflow = '';
        if (this._lastFocus?.focus) this._lastFocus.focus({ preventScroll: true });
        document.dispatchEvent(new CustomEvent('ui:overlay', { detail: { open: this._open > 0, count: this._open } }));
    },
    anyModalOpen() {
        return !!document.querySelector('.takeover.active, .sheet.active, .cmdk.active');
    },

    /* --- Confirm --- */
    confirm({ title = 'Biztos vagy benne?', text = '', okLabel = 'Törlés', kicker = 'Megerősítés' } = {}) {
        return new Promise((resolve) => {
            const dlg = document.getElementById('confirm-dialog');
            if (!dlg) return resolve(window.confirm(`${title}\n${text}`));

            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-text').textContent = text;
            document.getElementById('confirm-ico').textContent = kicker;

            const okBtn = document.getElementById('confirm-ok');
            const cancelBtn = document.getElementById('confirm-cancel');
            okBtn.textContent = okLabel;

            const done = (result) => {
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                dlg.removeEventListener('click', onBackdrop);
                this.closeModal(dlg);
                resolve(result);
            };
            const onOk = () => done(true);
            const onCancel = () => done(false);
            const onBackdrop = (e) => { if (e.target === dlg) done(false); };

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            dlg.addEventListener('click', onBackdrop);

            this.openModal(dlg);
            setTimeout(() => okBtn.focus({ preventScroll: true }), 80);
        });
    },

    /* --- Popover --- */
    togglePop(el, force) {
        if (!el) return;
        const willOpen = force !== undefined ? force : !el.classList.contains('open');
        document.querySelectorAll('.menu-pop.open').forEach(p => { if (p !== el) p.classList.remove('open'); });
        el.classList.toggle('open', willOpen);
        const chip = document.getElementById('user-chip');
        if (chip) chip.setAttribute('aria-expanded', String(el.id === 'user-pop' && willOpen));
        return willOpen;
    },
    closeAllPops() {
        document.querySelectorAll('.menu-pop.open').forEach(p => p.classList.remove('open'));
        document.getElementById('user-chip')?.setAttribute('aria-expanded', 'false');
    },

    progress(on) {
        document.getElementById('top-progress')?.classList.toggle('on', !!on);
    }
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-pop') && !e.target.closest('#user-chip') && !e.target.closest('#mobile-menu-btn')) {
        UI.closeAllPops();
    }
});
