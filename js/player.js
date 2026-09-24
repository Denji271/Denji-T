/**
 * Denji-T · Lejátszó
 * Saját vezérlőfelület a reklámmentes <video> fölé: idősáv, hangerő, sebesség,
 * felirat a Drive-ról, teljes képernyő, folytatás és következő rész.
 */

const KEY_POS = 'denjit_pos';
const KEY_VOLUME = 'denjit_volume';
const KEY_SUBS = 'denjit_subs';
const POS_LIMIT = 100;          // ennyi film/rész pozícióját tartjuk meg
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SEEK_STEP = 10;
const HIDE_DELAY = 2500;
const NEXT_COUNTDOWN = 10;

const svgIcon = (body, filled) => `<svg viewBox="0 0 24 24" aria-hidden="true" ${filled
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;

const ICON = {
    play: svgIcon('<path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.1-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/>', true),
    pause: svgIcon('<rect x="6.5" y="5" width="4" height="14" rx="1.3"/><rect x="13.5" y="5" width="4" height="14" rx="1.3"/>', true),
    // A „10” a körív középpontjára van mérve (12.09 / 11.91, 12.0) — a számjegyek tényleges alakja szerint
    back: svgIcon('<path d="M4.6 12.4A7.5 7.5 0 1 0 7 6.5"/><path d="M7.4 2.9 6.6 6.8l3.9.9"/><text x="12.05" y="14.42" text-anchor="middle" font-size="6.6" font-weight="700" fill="currentColor" stroke="none">10</text>'),
    fwd: svgIcon('<path d="M19.4 12.4A7.5 7.5 0 1 1 17 6.5"/><path d="m16.6 2.9.8 3.9-3.9.9"/><text x="11.87" y="14.42" text-anchor="middle" font-size="6.6" font-weight="700" fill="currentColor" stroke="none">10</text>'),
    vol: svgIcon('<path d="M4 9.6h3.2L11.5 6v12l-4.3-3.6H4z" fill="currentColor"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6"/><path d="M17.8 6.6a7.6 7.6 0 0 1 0 10.8"/>'),
    mute: svgIcon('<path d="M4 9.6h3.2L11.5 6v12l-4.3-3.6H4z" fill="currentColor"/><path d="m15.5 9.5 5 5m0-5-5 5"/>'),
    subs: svgIcon('<rect x="3" y="5" width="18" height="14" rx="3.5"/><path d="M7 11.5h3M12.5 11.5H17M7 15h6.5M15.8 15H17"/>'),
    full: svgIcon('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>'),
    exitFull: svgIcon('<path d="M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4M20 9h-3.5A1.5 1.5 0 0 1 15 7.5V4M15 20v-3.5a1.5 1.5 0 0 1 1.5-1.5H20M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20"/>'),
};

const speedLabel = (s) => `${String(s).replace('.', ',')}×`;

/* 1:02:03 vagy 4:05 */
const fmtTime = (sec) => {
    const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};

/* ---------------- Felirat ---------------- */

const SUB_LANGS = [
    [/(^|[^a-z])(hu|hun|hungarian|magyar)([^a-z]|$)/i, 'Magyar'],
    [/(^|[^a-z])(en|eng|english|angol)([^a-z]|$)/i, 'Angol'],
];

/* A felirat neve a fájlnévből; nyelvjelölés híján egyszerűen „Felirat” */
function subtitleLabels(subs) {
    let unnamed = 0;
    return subs.map(sub => {
        const hit = SUB_LANGS.find(([re]) => re.test(sub.name.replace(/\.(srt|vtt)$/i, '')));
        if (hit) return hit[1];
        unnamed++;
        return unnamed > 1 ? `Felirat ${unnamed}` : 'Felirat';
    });
}

/* A magyar feliratok gyakran Windows-1250 kódolásúak, nem UTF-8 */
function decodeSubtitle(buf) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
        return new TextDecoder('windows-1250').decode(buf);
    }
}

function srtToVtt(text) {
    const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    if (body.startsWith('WEBVTT')) return body;
    return 'WEBVTT\n\n' + body.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

/* Csak a dőlt/félkövér/aláhúzott jelölés marad meg, minden más szövegként jelenik meg */
const cueHtml = (text) => esc(text.replace(/\{[^}]*\}/g, '').replace(/<\/?font[^>]*>/gi, ''))
    .replace(/&lt;(\/?)([ibu])&gt;/gi, '<$1$2>')
    .replace(/\n/g, '<br>');

class Player {
    constructor(box, video) {
        this.box = box;
        this.video = video;
        this.ctx = null;            // { key, title, subtitles, onNext, nextLabel, onPrev }
        this.rate = 1;
        this.subIndex = -1;
        this._sub = null;           // { el, url }
        this._subToken = 0;
        this._dragT = null;
        this._resumeTo = null;
        this._saveAt = 0;
        this._hideT = 0;
        this._resumeT = 0;
        this._nextT = 0;
        this._raf = 0;
        this._lastTap = 0;
        this._lastPointer = '';
        this._swallowTap = false;

        this.build();
        this.bind();
        const saved = Store.get(KEY_VOLUME, { v: 1, m: false });
        video.volume = Math.min(1, Math.max(0, Number(saved.v) || 0));
        video.muted = !!saved.m;
        this.syncVolume(false);
    }

    /* A saját felület csak akkor él, ha a natív videó látszik */
    get active() {
        return !!this.ctx && this.box.classList.contains('pl-on');
    }

    build() {
        this.root = document.createElement('div');
        this.root.className = 'player';
        this.root.innerHTML = `
            <div class="pl-subs"></div>
            <div class="pl-top"></div>
            <div class="pl-flash"></div>
            <button type="button" class="pl-big" data-act="play" aria-label="Lejátszás">${ICON.play}</button>
            <div class="pl-card pl-resume" hidden>
                <span class="pl-resume-text"></span>
                <button type="button" class="pill pill-light pill-sm" data-act="restart">Elölről</button>
            </div>
            <div class="pl-card pl-next" hidden>
                <span class="label">Következő rész</span>
                <strong class="pl-next-title"></strong>
                <span class="pl-next-count"></span>
                <span class="pl-next-bar"><i></i></span>
                <div class="pl-next-actions">
                    <button type="button" class="pill pill-dark pill-sm" data-act="next-now">Lejátszás most</button>
                    <button type="button" class="link-quiet" data-act="next-cancel">Mégse</button>
                </div>
            </div>
            <div class="pl-bar">
                <div class="pl-seek" role="slider" tabindex="0" aria-label="Idősáv" aria-valuemin="0" aria-valuenow="0">
                    <div class="pl-rail"><i class="pl-buf"></i><i class="pl-played"></i></div>
                    <span class="pl-thumb"></span>
                    <span class="pl-tip"></span>
                </div>
                <div class="pl-row">
                    <div class="pl-group">
                        <button type="button" class="pl-btn" data-act="play" aria-label="Lejátszás">${ICON.play}</button>
                        <button type="button" class="pl-btn pl-skip" data-act="back" aria-label="10 mp vissza">${ICON.back}</button>
                        <button type="button" class="pl-btn pl-skip" data-act="fwd" aria-label="10 mp előre">${ICON.fwd}</button>
                        <div class="pl-vol">
                            <button type="button" class="pl-btn" data-act="mute" aria-label="Némítás">${ICON.vol}</button>
                            <input type="range" class="pl-vol-range" min="0" max="1" step="0.05" aria-label="Hangerő">
                        </div>
                        <span class="pl-time"><span class="pl-cur">0:00</span><span class="pl-dur-part"> / <span class="pl-dur">0:00</span></span></span>
                    </div>
                    <div class="pl-group">
                        <div class="pl-menu-wrap">
                            <button type="button" class="pl-btn" data-act="subs" aria-label="Felirat" hidden>${ICON.subs}</button>
                            <div class="pl-menu" data-menu="subs" hidden></div>
                        </div>
                        <div class="pl-menu-wrap">
                            <button type="button" class="pl-btn pl-speed" data-act="speed" aria-label="Lejátszási sebesség">1×</button>
                            <div class="pl-menu" data-menu="speed" hidden></div>
                        </div>
                        <button type="button" class="pl-btn" data-act="fs" aria-label="Teljes képernyő">${ICON.full}</button>
                    </div>
                </div>
            </div>`;
        this.box.appendChild(this.root);

        const $ = (sel) => this.root.querySelector(sel);
        this.el = {
            subs: $('.pl-subs'), top: $('.pl-top'), flash: $('.pl-flash'), bar: $('.pl-bar'),
            seek: $('.pl-seek'), buf: $('.pl-buf'), played: $('.pl-played'), thumb: $('.pl-thumb'), tip: $('.pl-tip'),
            play: $('.pl-row [data-act="play"]'), mute: $('[data-act="mute"]'), vol: $('.pl-vol-range'),
            cur: $('.pl-cur'), dur: $('.pl-dur'), subsBtn: $('[data-act="subs"]'), speed: $('[data-act="speed"]'),
            fs: $('[data-act="fs"]'), resume: $('.pl-resume'), resumeText: $('.pl-resume-text'),
            next: $('.pl-next'), nextTitle: $('.pl-next-title'), nextCount: $('.pl-next-count'),
            nextBar: $('.pl-next-bar i'),
        };
    }

    bind() {
        const v = this.video;
        const on = (type, fn) => v.addEventListener(type, (e) => { if (this.ctx) fn(e); });

        on('play', () => {
            this.cancelNext();
            this.box.classList.remove('pl-paused');
            this.syncPlayIcon();
            this.poke();
        });
        on('pause', () => {
            this.box.classList.add('pl-paused');
            this.syncPlayIcon();
            this.stopLoop();
            this.savePos();
        });
        on('playing', () => { this.setLoading(false); this.startLoop(); });
        on('waiting', () => this.setLoading(true));
        on('canplay', () => this.setLoading(false));
        on('seeking', () => this.render());
        on('seeked', () => { this.setLoading(false); this.render(); });
        on('progress', () => this.renderBuffered());
        on('timeupdate', () => {
            if (v.paused) this.render();
            this.renderBuffered();
            if (!v.paused && Date.now() - this._saveAt > 5000) this.savePos();
        });
        on('loadedmetadata', () => this.onMetadata());
        on('resize', () => this.layout());   // a videó képmérete ismertté vált vagy változott
        on('durationchange', () => { this.el.dur.textContent = fmtTime(v.duration); this.render(); });
        on('ended', () => {
            this.box.classList.add('pl-paused');
            this.syncPlayIcon();
            this.stopLoop();
            this.savePos();
            this.showNext();
        });
        v.addEventListener('volumechange', () => this.syncVolume(!!this.ctx));
        on('ratechange', () => this.syncSpeed());

        // Gombok és menüpontok
        this.root.addEventListener('click', (e) => {
            if (!this.ctx) return;
            const opt = e.target.closest('.pl-opt');
            if (opt) return this.pickOption(opt);
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            if (e.detail) btn.blur();   // egérkattintás után a szóköz ne ezt a gombot nyomja újra
            this.act(btn.dataset.act);
            this.poke();
        });

        // Kattintás a képre: egérrel lejátszás/szünet, érintéssel vezérlők, dupla koppintás a szélein ugrás
        this.root.addEventListener('pointerup', (e) => {
            this._lastPointer = e.pointerType;
            if (e.target !== this.root || !this.ctx) return;
            if (this._swallowTap) { this._swallowTap = false; return; }
            if (e.pointerType === 'mouse') {
                if (e.button === 0) this.toggle();
                return;
            }
            const now = Date.now();
            const r = this.root.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width;
            if (now - this._lastTap < 300 && (x < 0.35 || x > 0.65)) {
                this._lastTap = 0;
                this.skip(x < 0.35 ? -SEEK_STEP : SEEK_STEP);
                return;
            }
            this._lastTap = now;
            if (this.box.classList.contains('pl-awake') && !v.paused) this.sleep(true);
            else this.poke();
        });
        this.root.addEventListener('dblclick', (e) => {
            if (e.target === this.root && this.ctx && this._lastPointer === 'mouse') this.toggleFullscreen();
        });

        this.box.addEventListener('mousemove', () => this.poke());
        this.box.addEventListener('mouseleave', () => this.sleep(true));

        // Húzható idősáv
        const seek = this.el.seek;
        const ratioAt = (e) => {
            const r = seek.getBoundingClientRect();
            return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        };
        seek.addEventListener('pointerdown', (e) => {
            if (!this.ctx || !v.duration) return;
            e.preventDefault();
            seek.setPointerCapture(e.pointerId);
            seek.classList.add('dragging');
            this._dragT = ratioAt(e) * v.duration;
            this.showTip(e);
            this.render();
        });
        seek.addEventListener('pointermove', (e) => {
            if (!v.duration) return;
            this.showTip(e);
            if (this._dragT === null) return;
            this._dragT = ratioAt(e) * v.duration;
            this.render();
        });
        const release = () => {
            if (this._dragT === null) return;
            v.currentTime = this._dragT;
            this._dragT = null;
            seek.classList.remove('dragging');
            this.render();
            this.poke();
        };
        seek.addEventListener('pointerup', release);
        seek.addEventListener('pointercancel', release);

        this.el.vol.addEventListener('input', () => {
            v.volume = Number(this.el.vol.value);
            v.muted = v.volume === 0;
        });

        // Menüből kattintva kifelé: csak bezárjuk, a kép ne kapjon kattintást
        document.addEventListener('pointerdown', (e) => {
            if (!e.target.closest?.('.pl-menu-wrap') && this.closeMenus()) {
                if (this.root.contains(e.target)) this._swallowTap = true;
            }
        });

        // Átméretezéskor (ablak, teljes képernyő, telefon forgatása) újraszámoljuk a kép közepét
        new ResizeObserver(() => this.layout()).observe(this.box);

        const onFs = () => this.syncFullscreen();
        document.addEventListener('fullscreenchange', onFs);
        document.addEventListener('webkitfullscreenchange', onFs);

        window.addEventListener('pagehide', () => this.savePos());
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.savePos(); });
    }

    /* ---------------- Forrás ---------------- */

    attach(ctx) {
        this.detach();
        this.ctx = { ...ctx, subtitles: ctx?.subtitles || [] };
        const v = this.video;
        v.defaultPlaybackRate = this.rate;
        v.playbackRate = this.rate;

        this.el.top.textContent = this.ctx.title || '';
        this.el.dur.textContent = '0:00';
        this.el.buf.style.width = '0%';
        this.el.subsBtn.hidden = !this.ctx.subtitles.length;
        this.box.classList.add('pl-on', 'pl-paused', 'pl-awake');
        this.syncPlayIcon();
        this.syncSpeed();
        this.render();
        this.layout();

        const saved = this.ctx.key ? Store.get(KEY_POS, {})[this.ctx.key] : null;
        this._resumeTo = saved?.t > 30 ? saved.t : null;

        if (this.ctx.subtitles.length && Store.get(KEY_SUBS, false)) this.selectSub(this.preferredSub());
    }

    detach() {
        if (!this.ctx) return;
        this.savePos();
        this.cancelNext();
        this.hideResume();
        this.closeMenus();
        this.clearSub();
        this.stopLoop();
        clearTimeout(this._hideT);
        this._dragT = null;
        this._resumeTo = null;
        this.ctx = null;
        this.el.seek.classList.remove('dragging');
        this.box.classList.remove('pl-on', 'pl-awake', 'pl-paused', 'pl-next-on', 'stage-loading');
        this.layout();
    }

    /* A nagy gomb, a kártya és a színpad nyilai a ténylegesen látható kép közepére kerülnek:
       a videó képe a fekete sávok nélkül, a vezérlősáv fölött. A sáv széles képnél
       az alsó fekete csíkot takarja, ezért a doboz közepe ilyenkor lejjebb esik a kép közepénél. */
    layout() {
        const stage = this.box.parentElement;
        if (!this.ctx) {
            this.box.style.removeProperty('--pl-cy');
            this.box.style.removeProperty('--pl-bar-space');
            stage?.style.removeProperty('--pl-stage-cy');
            return;
        }
        const W = this.box.clientWidth;
        const H = this.box.clientHeight;
        if (!W || !H) return;

        const { videoWidth: vw, videoHeight: vh } = this.video;
        let top = 0;
        let bottom = H;
        if (vw && vh) {
            const h = Math.min(H, (W / vw) * vh);
            top = (H - h) / 2;
            bottom = top + h;
        }
        const barTop = this.el.bar.offsetTop;
        const cy = (top + Math.min(bottom, barTop)) / 2;

        this.box.style.setProperty('--pl-cy', `${cy.toFixed(1)}px`);
        this.box.style.setProperty('--pl-bar-space', `${H - barTop}px`);
        // A nyilak a dobozon kívül, a színpadon vannak: ott a doboz kerete is beleszámít
        stage?.style.setProperty('--pl-stage-cy', `${(cy + this.box.offsetTop + this.box.clientTop).toFixed(1)}px`);
    }

    onMetadata() {
        const v = this.video;
        this.layout();
        this.el.dur.textContent = fmtTime(v.duration);
        this.el.seek.setAttribute('aria-valuemax', Math.floor(v.duration) || 0);
        const to = this._resumeTo;
        this._resumeTo = null;
        if (to && v.duration - to > 60) {
            v.currentTime = to;
            this.showResume(to);
        }
        this.render();
    }

    /* ---------------- Folytatás ---------------- */

    savePos() {
        const key = this.ctx?.key;
        const v = this.video;
        const d = v.duration;
        if (!key || !d || !Number.isFinite(d) || this._resumeTo !== null) return;
        this._saveAt = Date.now();

        const all = Store.get(KEY_POS, {});
        const t = v.currentTime;
        // Az elején vagy a stáblistánál nincs mit folytatni
        if (t < 30 || d - t < 60 || t / d > 0.95) delete all[key];
        else all[key] = { t: Math.floor(t), d: Math.floor(d), at: Date.now() };

        const keys = Object.keys(all);
        if (keys.length > POS_LIMIT) {
            keys.sort((a, b) => all[a].at - all[b].at)
                .slice(0, keys.length - POS_LIMIT)
                .forEach(k => delete all[k]);
        }
        Store.set(KEY_POS, all);
    }

    showResume(t) {
        this.el.resumeText.textContent = `Folytatás innen: ${fmtTime(t)}`;
        this.el.resume.hidden = false;
        clearTimeout(this._resumeT);
        this._resumeT = setTimeout(() => this.hideResume(), 7000);
    }

    hideResume() {
        clearTimeout(this._resumeT);
        this.el.resume.hidden = true;
    }

    /* ---------------- Következő rész ---------------- */

    showNext() {
        if (!this.ctx?.onNext) return;
        let left = NEXT_COUNTDOWN;
        const bar = this.el.nextBar;
        // A csíkot másodpercenként léptetjük, így mozgáscsökkentés mellett is látszik a hátralévő idő
        const tick = () => {
            this.el.nextCount.textContent = `${left} mp múlva indul`;
            bar.style.transform = `scaleX(${(left - 1) / NEXT_COUNTDOWN})`;
        };
        this.el.nextTitle.textContent = this.ctx.nextLabel || '';
        this.el.next.hidden = false;
        bar.style.transition = 'none';
        bar.style.transform = 'scaleX(1)';
        void bar.offsetWidth;
        bar.style.transition = '';
        tick();
        this.box.classList.add('pl-next-on');
        clearInterval(this._nextT);
        this._nextT = setInterval(() => {
            left--;
            if (left <= 0) return this.playNext();
            tick();
        }, 1000);
    }

    cancelNext() {
        clearInterval(this._nextT);
        this._nextT = 0;
        this.el.next.hidden = true;
        this.box.classList.remove('pl-next-on');
    }

    playNext() {
        const next = this.ctx?.onNext;
        this.cancelNext();
        next?.();
    }

    /* ---------------- Felirat ---------------- */

    preferredSub() {
        const labels = subtitleLabels(this.ctx?.subtitles || []);
        return Math.max(0, labels.indexOf('Magyar'));
    }

    async selectSub(index) {
        this.clearSub();
        const sub = this.ctx?.subtitles[index];
        if (!sub) {
            Store.set(KEY_SUBS, false);
            return;
        }
        Store.set(KEY_SUBS, true);
        this.subIndex = index;
        this.el.subsBtn.classList.add('on');
        const token = ++this._subToken;

        try {
            const res = await fetch(`${DRIVE_FILES}/${sub.id}?alt=media&key=${CONFIG.GOOGLE_API_KEY}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const vtt = srtToVtt(decodeSubtitle(await res.arrayBuffer()));
            if (token !== this._subToken) return;   // közben másik feliratra vagy részre váltott

            const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
            const el = document.createElement('track');
            el.kind = 'subtitles';
            el.src = url;
            this.video.appendChild(el);
            // Rejtett sáv: a szöveget mi rajzoljuk ki, hogy a vezérlők fölé kerüljön
            el.track.mode = 'hidden';
            el.track.addEventListener('cuechange', () => this.renderCues());
            this._sub = { el, url };
        } catch (e) {
            if (token !== this._subToken) return;
            console.warn('Felirat betöltése sikertelen:', e);
            this.clearSub();
            UI.toast('A felirat nem tölthető be.', 'error', 3000);
        }
    }

    clearSub() {
        this._subToken++;
        if (this._sub) {
            this._sub.el.remove();
            URL.revokeObjectURL(this._sub.url);
            this._sub = null;
        }
        this.subIndex = -1;
        this.el.subs.innerHTML = '';
        this.el.subsBtn.classList.remove('on');
    }

    renderCues() {
        const cues = this._sub?.el.track.activeCues;
        this.el.subs.innerHTML = cues ? [...cues].map(c => `<span>${cueHtml(c.text)}</span>`).join('') : '';
    }

    toggleSubs() {
        if (!this.ctx?.subtitles.length) return;
        if (this.subIndex >= 0) {
            this.clearSub();
            Store.set(KEY_SUBS, false);
            this.flash('center', 'Felirat ki');
        } else {
            this.selectSub(this.preferredSub());
            this.flash('center', 'Felirat be');
        }
    }

    /* ---------------- Menük ---------------- */

    openMenu(name) {
        const menu = this.root.querySelector(`.pl-menu[data-menu="${name}"]`);
        const wasOpen = !menu.hidden;
        this.closeMenus();
        if (wasOpen) return;

        if (name === 'speed') {
            menu.innerHTML = '<span class="label">Sebesség</span>' + SPEEDS.map(s =>
                `<button type="button" class="pl-opt ${s === this.rate ? 'active' : ''}" data-menu-opt="speed" data-value="${s}">${s === 1 ? 'Normál' : speedLabel(s)}</button>`).join('');
        } else {
            const labels = subtitleLabels(this.ctx.subtitles);
            menu.innerHTML = '<span class="label">Felirat</span>'
                + `<button type="button" class="pl-opt ${this.subIndex < 0 ? 'active' : ''}" data-menu-opt="subs" data-value="-1">Ki</button>`
                + labels.map((label, i) =>
                    `<button type="button" class="pl-opt ${i === this.subIndex ? 'active' : ''}" data-menu-opt="subs" data-value="${i}">${esc(label)}</button>`).join('');
        }
        menu.hidden = false;
        // A doboz levágja, ami kilóg: kis képernyőn a menü görgethető lesz
        menu.style.maxHeight = `${Math.max(90, this.box.clientHeight - this.el.bar.offsetHeight - 34)}px`;
        this.box.classList.add('pl-menu-open');
        this.poke();
    }

    closeMenus() {
        const open = [...this.root.querySelectorAll('.pl-menu:not([hidden])')];
        open.forEach(m => { m.hidden = true; });
        this.box.classList.remove('pl-menu-open');
        return open.length > 0;
    }

    pickOption(opt) {
        const value = Number(opt.dataset.value);
        if (opt.dataset.menuOpt === 'speed') {
            this.rate = value;
            this.video.defaultPlaybackRate = value;
            this.video.playbackRate = value;
        } else {
            this.selectSub(value);
        }
        this.closeMenus();
        this.poke();
    }

    /* ---------------- Műveletek ---------------- */

    act(name) {
        switch (name) {
            case 'play': return this.toggle();
            case 'back': return this.skip(-SEEK_STEP);
            case 'fwd': return this.skip(SEEK_STEP);
            case 'mute': return this.toggleMute();
            case 'fs': return this.toggleFullscreen();
            case 'speed': return this.openMenu('speed');
            case 'subs': return this.openMenu('subs');
            case 'restart':
                this.video.currentTime = 0;
                return this.hideResume();
            case 'next-now': return this.playNext();
            case 'next-cancel': return this.cancelNext();
        }
    }

    toggle() {
        const v = this.video;
        if (v.paused || v.ended) v.play().catch(() => {});
        else v.pause();
    }

    skip(delta) {
        const v = this.video;
        if (!v.duration) return;
        v.currentTime = Math.min(v.duration - 0.5, Math.max(0, v.currentTime + delta));
        this.flash(delta < 0 ? 'left' : 'right', `${delta < 0 ? '−' : '+'}${Math.abs(delta)}`);
        this.render();
    }

    toggleMute() {
        const v = this.video;
        v.muted = !v.muted;
        if (!v.muted && v.volume === 0) v.volume = 0.5;
    }

    nudgeVolume(delta) {
        const v = this.video;
        v.volume = Math.min(1, Math.max(0, Math.round((v.volume + delta) * 20) / 20));
        v.muted = v.volume === 0;
        this.flash('center', `${Math.round(v.volume * 100)}%`);
    }

    toggleFullscreen() {
        const doc = document;
        if (doc.fullscreenElement || doc.webkitFullscreenElement) {
            (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)?.catch?.(() => {});
            return;
        }
        const request = this.box.requestFullscreen || this.box.webkitRequestFullscreen;
        if (request) request.call(this.box)?.catch?.(() => {});
        else this.video.webkitEnterFullscreen?.();   // iPhone: csak a videó mehet teljes képernyőre
    }

    /* Billentyűk — igazat ad vissza, ha a lejátszó kezelte */
    handleKey(e) {
        if (!this.active || e.ctrlKey || e.metaKey || e.altKey) return false;
        const tag = document.activeElement?.tagName;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const overPlayer = this.box.matches(':hover') || this.box.classList.contains('pl-fs');
        const actions = {
            ' ': () => this.toggle(),
            k: () => this.toggle(),
            ArrowLeft: () => this.skip(-SEEK_STEP),
            j: () => this.skip(-SEEK_STEP),
            ArrowRight: () => this.skip(SEEK_STEP),
            l: () => this.skip(SEEK_STEP),
            // Fel/le csak a lejátszó fölött hangerő, máshol marad görgetés
            ArrowUp: overPlayer && (() => this.nudgeVolume(0.05)),
            ArrowDown: overPlayer && (() => this.nudgeVolume(-0.05)),
            m: () => this.toggleMute(),
            f: () => this.toggleFullscreen(),
            c: this.ctx.subtitles.length && (() => this.toggleSubs()),
            n: this.ctx.onNext && (() => this.playNext()),
            p: this.ctx.onPrev && (() => this.ctx.onPrev()),
        };
        const run = actions[key];
        if (!run) return false;
        // Gombon a szóköz a gombot nyomja meg, a hangerőcsúszkán a nyilak a csúszkát mozgatják
        if (key === ' ' && (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A')) return false;
        if (tag === 'INPUT' && key.startsWith('Arrow')) return false;
        e.preventDefault();
        run();
        this.poke();
        return true;
    }

    /* ---------------- Megjelenítés ---------------- */

    poke() {
        if (!this.ctx) return;
        this.box.classList.add('pl-awake');
        clearTimeout(this._hideT);
        this._hideT = setTimeout(() => this.sleep(), HIDE_DELAY);
    }

    sleep(now = false) {
        clearTimeout(this._hideT);
        if (!this.ctx || this.box.classList.contains('pl-menu-open') || this._dragT !== null) return;
        // Amíg az egér a vezérlősávon pihen, az marad látható
        if (!now && this.el.bar.matches(':hover')) {
            this._hideT = setTimeout(() => this.sleep(), HIDE_DELAY);
            return;
        }
        this.box.classList.remove('pl-awake');
    }

    setLoading(on) {
        this.box.classList.toggle('stage-loading', on);
    }

    startLoop() {
        cancelAnimationFrame(this._raf);
        const loop = () => {
            this.render();
            this._raf = requestAnimationFrame(loop);
        };
        this._raf = requestAnimationFrame(loop);
    }

    stopLoop() {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
    }

    render() {
        const v = this.video;
        const d = v.duration || 0;
        const t = this._dragT ?? v.currentTime;
        const pct = d ? Math.min(100, (t / d) * 100) : 0;
        this.el.played.style.width = `${pct}%`;
        this.el.thumb.style.left = `${pct}%`;
        this.el.cur.textContent = fmtTime(t);
        this.el.seek.setAttribute('aria-valuenow', Math.floor(t));
        this.el.seek.setAttribute('aria-valuetext', `${fmtTime(t)} / ${fmtTime(d)}`);
    }

    renderBuffered() {
        const v = this.video;
        const d = v.duration;
        if (!d) return;
        let end = 0;
        for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) {
                end = v.buffered.end(i);
                break;
            }
        }
        this.el.buf.style.width = `${Math.min(100, (end / d) * 100)}%`;
    }

    showTip(e) {
        const r = this.el.seek.getBoundingClientRect();
        const x = Math.min(r.width, Math.max(0, e.clientX - r.left));
        this.el.tip.textContent = fmtTime((x / r.width) * (this.video.duration || 0));
        // A buborék ne lógjon ki a sáv széleinél
        this.el.tip.style.left = `${Math.min(r.width - 30, Math.max(30, x))}px`;
    }

    flash(side, text) {
        const el = this.el.flash;
        el.textContent = text;
        el.className = `pl-flash ${side}`;
        void el.offsetWidth;   // az animáció újraindításához
        el.classList.add('show');
    }

    syncPlayIcon() {
        const playing = !this.video.paused && !this.video.ended;
        this.el.play.innerHTML = playing ? ICON.pause : ICON.play;
        this.el.play.setAttribute('aria-label', playing ? 'Szünet' : 'Lejátszás');
    }

    syncVolume(store) {
        const v = this.video;
        const level = v.muted ? 0 : v.volume;
        this.el.vol.value = String(level);
        this.el.vol.style.setProperty('--vol', `${level * 100}%`);
        this.el.mute.innerHTML = level === 0 ? ICON.mute : ICON.vol;
        this.el.mute.setAttribute('aria-label', level === 0 ? 'Hang be' : 'Némítás');
        if (store) Store.set(KEY_VOLUME, { v: v.volume, m: v.muted });
    }

    syncSpeed() {
        this.el.speed.textContent = speedLabel(this.video.playbackRate);
    }

    syncFullscreen() {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const on = fsEl === this.box;
        this.box.classList.toggle('pl-fs', on);
        this.el.fs.innerHTML = on ? ICON.exitFull : ICON.full;
        this.el.fs.setAttribute('aria-label', on ? 'Kilépés a teljes képernyőből' : 'Teljes képernyő');
        // Telefonon fekvő módba fordítjuk, ha a böngésző engedi
        if (on) screen.orientation?.lock?.('landscape').catch(() => {});
        this.poke();
    }
}
