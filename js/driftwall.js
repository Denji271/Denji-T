/**
 * DriftWall — vanilla port (React Bits · DriftWall)
 * 3D-ben sodródó csempefal. Oszloponként eltérő sebesség, mutatóra dőlő sík,
 * hoverre kiemelkedő csempe. Nincs függősége.
 *
 *   const wall = new DriftWall(el, { items, columns: 6, onSelect(item) {} });
 *   wall.setItems(items);  wall.destroy();
 */

const DW_DEFAULTS = {
    items: [],
    columns: 'auto',      // szám vagy 'auto' (a konténer szélességéből)
    overscan: 2,          // hány extra oszlop lógjon túl a széleken
    maxColumns: 9,
    offsetX: 0,           // vízszintes eltolás a konténer szélességének arányában
    tileWidth: 200,
    tileHeight: 132,
    gap: 18,
    radius: 0,
    tilt: 16,             // rotateX
    turn: -14,            // rotateY
    roll: 0,              // rotateZ
    perspective: 1200,
    depth: 120,
    scale: 1.18,
    speed: 42,
    direction: 'up',
    variance: 0.45,
    parallax: 0.6,
    pauseOnHover: false,
    lift: 64,
    fade: 0.6,
    dim: 0.55,
    grayscale: true,
    overlayColor: '#000000',
    interactive: true,    // false → dekoratív háttér (nincs találatvizsgálat)
    pointerTarget: null,  // ahol az egérmozgást figyeljük (dekoratív falnál a szülő szekció)
    onSelect: null,       // (item) => void
    onActive: null        // (item | null, index) => void
};

const dwReducedMotion = () =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Aranymetszéses ál-véletlen: determinisztikus, de nem szabályos oszlopsebességek
const dwColumnFactor = (index, variance) => {
    const pseudo = ((index * 0.6180339887 + 0.35) % 1) * 2 - 1;
    return 1 + variance * pseudo;
};

class DriftWall {
    constructor(root, options = {}) {
        this.root = root;
        this.opts = { ...DW_DEFAULTS, ...options };
        this.items = this.opts.items || [];

        this.offsets = [];
        this.velocities = [];
        this.columnItems = [];
        this.columnMeta = [];
        this.tracks = [];

        this.pointer = { x: 0, y: 0 };
        this.damped = { x: 0, y: 0 };
        this.client = null;
        this.hitPending = false;

        this.hoveredCol = -1;
        this.activeId = null;
        this.wallHovered = false;
        this.paused = false;
        this.visible = true;

        this.raf = null;
        this.lastTs = null;
        this.height = root.clientHeight || 600;
        this.width = root.clientWidth || 800;
        this.reduced = dwReducedMotion();

        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerEnter = this._onPointerEnter.bind(this);
        this._onPointerLeave = this._onPointerLeave.bind(this);
        this._onClick = this._onClick.bind(this);
        this._onKey = this._onKey.bind(this);
        this._loop = this._loop.bind(this);

        this._mount();
        this._observe();
        this._bind();
        this.start();
    }

    /* ---------------- felépítés ---------------- */
    _mount() {
        const o = this.opts;
        this.root.classList.add('drift-wall');
        this.root.setAttribute('role', 'group');
        this.root.setAttribute('aria-label', 'Sodródó borítófal');
        if (!o.interactive) this.root.classList.add('drift-wall--ambient');

        this._applyVars();

        this.plane = document.createElement('div');
        this.plane.className = 'drift-wall__plane';
        this.root.replaceChildren(this.plane);

        // Azonnal középre állítjuk — így az első képkocka előtt sem csúszik el a fal
        this._planeTransform(0, 0);
        this._buildColumns();
    }

    _applyVars() {
        const o = this.opts;
        const s = this.root.style;
        s.setProperty('--dw-tile-w', `${o.tileWidth}px`);
        s.setProperty('--dw-tile-h', `${o.tileHeight}px`);
        s.setProperty('--dw-gap', `${o.gap}px`);
        s.setProperty('--dw-radius', `${o.radius}px`);
        s.setProperty('--dw-perspective', `${o.perspective}px`);
        s.setProperty('--dw-lift', `${o.lift}px`);
        s.setProperty('--dw-dim', String(o.dim));
        s.setProperty('--dw-gray', o.grayscale ? '1' : '0');
        s.setProperty('--dw-overlay', o.overlayColor);
        s.setProperty('--dw-edge', `${Math.max(0, (1 - o.fade) * 100)}%`);
    }

    get columnCount() {
        const o = this.opts;
        if (o.columns !== 'auto') return Math.max(1, o.columns);
        const unit = o.tileWidth + o.gap;
        return Math.min(o.maxColumns, Math.max(3, Math.ceil(this.width / unit) + o.overscan));
    }

    _buildColumns() {
        const o = this.opts;
        const count = this.columnCount;
        const items = this.items.length ? this.items : [];
        if (!items.length) {
            this.plane.replaceChildren();
            this.tracks = [];
            this.columnItems = [];
            this.columnMeta = [];
            return;
        }

        // Elemek szétosztása oszlopokra
        const cols = Array.from({ length: count }, () => []);
        items.forEach((item, i) => cols[i % count].push(item));
        this.columnItems = cols.map(col => (col.length ? col : items.slice(0, 1)));

        const unit = o.tileHeight + o.gap;
        this.columnMeta = this.columnItems.map(col => {
            const copyHeight = Math.max(unit, col.length * unit);
            const copies = Math.max(2, Math.ceil((this.height * 1.6) / copyHeight) + 1);
            return { copyHeight, copies };
        });

        const dirSign = o.direction === 'up' ? 1 : -1;
        this.baseVelocities = this.columnItems.map((_, c) => {
            const altSign = c % 2 === 0 ? 1 : -1;
            return o.speed * dwColumnFactor(c, o.variance) * dirSign * altSign;
        });

        this.offsets = this.columnMeta.map((meta, c) => meta.copyHeight * ((c * 0.37) % 1));
        this.velocities = this.columnItems.map(() => 0);

        const frag = document.createDocumentFragment();
        this.tracks = [];

        this.columnItems.forEach((col, c) => {
            const colEl = document.createElement('div');
            colEl.className = 'drift-wall__col';
            const track = document.createElement('div');
            track.className = 'drift-wall__track';

            const meta = this.columnMeta[c];
            for (let copy = 0; copy < meta.copies; copy++) {
                col.forEach((item, i) => track.appendChild(this._tile(item, `${c}-${copy}-${i}`, c)));
            }
            colEl.appendChild(track);
            frag.appendChild(colEl);
            this.tracks.push(track);
        });

        this.plane.replaceChildren(frag);
    }

    _tile(item, id, colIndex) {
        const el = document.createElement(item.href ? 'a' : 'div');
        el.className = 'drift-wall__tile';
        el.dataset.tileId = id;
        el.dataset.col = String(colIndex);
        if (item.id != null) el.dataset.itemId = item.id;
        if (item.href) {
            el.href = item.href;
            el.target = '_blank';
            el.rel = 'noreferrer noopener';
        } else if (this.opts.interactive) {
            el.tabIndex = 0;
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', item.title || 'csempe');
        }

        const inner = document.createElement('span');
        inner.className = 'drift-wall__inner';

        if (item.image) {
            const img = document.createElement('img');
            img.src = item.image;
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.draggable = false;
            img.referrerPolicy = 'no-referrer';
            img.addEventListener('error', () => img.remove(), { once: true });
            inner.appendChild(img);
        } else {
            const empty = document.createElement('span');
            empty.className = 'drift-wall__empty';
            empty.textContent = (item.title || '').slice(0, 2).toUpperCase();
            inner.appendChild(empty);
        }

        const overlay = document.createElement('span');
        overlay.className = 'drift-wall__overlay';
        overlay.setAttribute('aria-hidden', 'true');
        inner.appendChild(overlay);

        el._dwItem = item;
        el.appendChild(inner);
        return el;
    }

    /* ---------------- események ---------------- */
    _observe() {
        if (typeof ResizeObserver === 'undefined') return;
        this.ro = new ResizeObserver(([entry]) => {
            const h = entry.contentRect.height || 600;
            const w = entry.contentRect.width || 800;
            const colsChanged = this.opts.columns === 'auto' &&
                Math.abs(w - this.width) > (this.opts.tileWidth + this.opts.gap) / 2;
            this.height = h;
            this.width = w;
            if (colsChanged) this._buildColumns();
            else this._recountCopies();
        });
        this.ro.observe(this.root);

        if (typeof IntersectionObserver !== 'undefined') {
            this.io = new IntersectionObserver(([entry]) => {
                this.visible = entry.isIntersecting;
            }, { rootMargin: '120px' });
            this.io.observe(this.root);
        }
    }

    _recountCopies() {
        const o = this.opts;
        this.columnItems.forEach((col, c) => {
            const meta = this.columnMeta[c];
            const track = this.tracks[c];
            if (!meta || !track) return;
            const needed = Math.max(2, Math.ceil((this.height * 1.6) / meta.copyHeight) + 1);
            if (needed === meta.copies) return;
            if (needed > meta.copies) {
                const frag = document.createDocumentFragment();
                for (let copy = meta.copies; copy < needed; copy++) {
                    col.forEach((item, i) => frag.appendChild(this._tile(item, `${c}-${copy}-${i}`, c)));
                }
                track.appendChild(frag);
            } else {
                const remove = (meta.copies - needed) * col.length;
                for (let i = 0; i < remove; i++) track.lastElementChild?.remove();
            }
            meta.copies = needed;
        });
    }

    _bind() {
        // Dekoratív falnál a csempék nem kapnak egeret, ezért a szülő szekciót figyeljük
        this.pointerHost = this.opts.pointerTarget || this.root;
        this.pointerHost.addEventListener('pointermove', this._onPointerMove, { passive: true });
        this.pointerHost.addEventListener('pointerenter', this._onPointerEnter);
        this.pointerHost.addEventListener('pointerleave', this._onPointerLeave);
        if (this.opts.interactive) {
            this.root.addEventListener('click', this._onClick);
            this.root.addEventListener('keydown', this._onKey);
            this.root.addEventListener('focusin', (e) => {
                const tile = e.target.closest?.('[data-tile-id]');
                if (tile) this._activate(tile);
            });
            this.root.addEventListener('focusout', () => this._release());
        }
    }

    _onPointerEnter() { this.wallHovered = true; }

    _onPointerLeave() {
        this.wallHovered = false;
        this.pointer = { x: 0, y: 0 };
        this.client = null;
        this._release();
    }

    _onPointerMove(e) {
        const rect = this.root.getBoundingClientRect();
        if (this.opts.parallax > 0 && !this.reduced) {
            this.pointer = {
                x: (e.clientX - rect.left) / rect.width - 0.5,
                y: (e.clientY - rect.top) / rect.height - 0.5
            };
        }
        if (this.opts.interactive) this.client = { x: e.clientX, y: e.clientY };
    }

    _hitTest() {
        if (!this.client) return;
        const hit = document.elementFromPoint(this.client.x, this.client.y);
        const tile = hit && hit.closest ? hit.closest('[data-tile-id]') : null;
        if (!tile || !this.root.contains(tile)) return this._release();
        if (tile.dataset.tileId === this.activeId) return;
        this._activate(tile);
    }

    _activate(tile) {
        if (this.activeEl && this.activeEl !== tile) this.activeEl.classList.remove('is-active');
        this.activeEl = tile;
        this.activeId = tile.dataset.tileId;
        this.hoveredCol = Number(tile.dataset.col);
        tile.classList.add('is-active');
        this.opts.onActive?.(tile._dwItem || null, this.hoveredCol);
    }

    _release() {
        if (this.activeEl) this.activeEl.classList.remove('is-active');
        this.activeEl = null;
        this.activeId = null;
        this.hoveredCol = -1;
        this.opts.onActive?.(null, -1);
    }

    _onClick(e) {
        const tile = e.target.closest?.('[data-tile-id]');
        if (!tile || tile.tagName === 'A') return;
        this.opts.onSelect?.(tile._dwItem, e);
    }

    _onKey(e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const tile = e.target.closest?.('[data-tile-id]');
        if (!tile) return;
        e.preventDefault();
        this.opts.onSelect?.(tile._dwItem, e);
    }

    /* ---------------- animáció ---------------- */
    _planeTransform(px, py) {
        const o = this.opts;
        const shift = o.offsetX ? ` translateX(${Math.round(o.offsetX * this.width)}px)` : '';
        this.plane.style.transform =
            `translate(-50%, -50%)${shift} scale(${o.scale}) ` +
            `rotateX(${o.tilt + py}deg) rotateY(${o.turn + px}deg) rotateZ(${o.roll}deg) ` +
            `translateZ(${-o.depth}px)`;
    }

    _loop(ts) {
        if (this.lastTs === null) this.lastTs = ts;
        const dt = Math.min(0.05, Math.max(0, ts - this.lastTs) / 1000);
        this.lastTs = ts;

        const maxTilt = this.opts.parallax * 8;
        const targetX = this.pointer.x * maxTilt;
        const targetY = -this.pointer.y * maxTilt;
        const damp = 1 - Math.exp(-dt / 0.12);
        this.damped.x += (targetX - this.damped.x) * damp;
        this.damped.y += (targetY - this.damped.y) * damp;
        this._planeTransform(this.damped.x, this.damped.y);

        if (this.opts.interactive && this.client && this.visible) this._hitTest();

        if (!this.reduced && this.visible && !this.paused) {
            for (let c = 0; c < this.tracks.length; c++) {
                const meta = this.columnMeta[c];
                if (!meta) continue;
                const frozen = (this.wallHovered && this.opts.pauseOnHover) || this.hoveredCol === c;
                const target = frozen ? 0 : this.baseVelocities[c];
                const ease = 1 - Math.exp(-dt / (target === 0 ? 0.16 : 0.28));
                this.velocities[c] += (target - this.velocities[c]) * ease;

                let next = (this.offsets[c] ?? 0) + this.velocities[c] * dt;
                next = ((next % meta.copyHeight) + meta.copyHeight) % meta.copyHeight;
                this.offsets[c] = next;
                this.tracks[c].style.transform = `translate3d(0, ${-next}px, 0)`;
            }
        }

        this.raf = requestAnimationFrame(this._loop);
    }

    /* ---------------- publikus API ---------------- */
    start() {
        if (this.raf) return;
        this.lastTs = null;
        this.raf = requestAnimationFrame(this._loop);
    }

    stop() {
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = null;
        this.lastTs = null;
    }

    setItems(items) {
        this.items = items || [];
        this._release();
        this._buildColumns();
    }

    setOptions(options = {}) {
        this.opts = { ...this.opts, ...options };
        this._applyVars();
        this._buildColumns();
    }

    setReduced(reduced) {
        this.reduced = !!reduced || dwReducedMotion();
        if (this.reduced) {
            this.pointer = { x: 0, y: 0 };
            this.damped = { x: 0, y: 0 };
            this._planeTransform(0, 0);
        }
    }

    destroy() {
        this.stop();
        this.ro?.disconnect();
        this.io?.disconnect();
        const host = this.pointerHost || this.root;
        host.removeEventListener('pointermove', this._onPointerMove);
        host.removeEventListener('pointerenter', this._onPointerEnter);
        host.removeEventListener('pointerleave', this._onPointerLeave);
        this.root.removeEventListener('click', this._onClick);
        this.root.removeEventListener('keydown', this._onKey);
        this.root.replaceChildren();
        this.root.classList.remove('drift-wall', 'drift-wall--ambient');
    }
}

window.DriftWall = DriftWall;
