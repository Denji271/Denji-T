/**
 * Denji-T · Előretöltés (Service Worker)
 * A böngésző magától csak kb. 20 mp-et tölt előre a videóból, ezért egy rövid
 * Streamtape-lassulás is megakasztja a lejátszást. Ez a háttérprogram átveszi a
 * lejátszó videókéréseit: percekkel előre letölti a filmet a memóriába, onnan
 * adja a lejátszónak, a már megnézett részt pedig eldobja. Ha bármi nem stimmel,
 * a kérés változatlanul a hálózatra megy, mintha itt sem lenne.
 */

const CHUNK = 512 * 1024;                   // ekkora darabokban tároljuk
const AHEAD = 64 * 1024 * 1024;             // ennyit töltünk előre (~4 perc egy 2 Mbit/s-os filmből)
const REFILL = 16 * 1024 * 1024;            // csak ennyi fogyás után kérünk újra: kevesebb, nagyobb kérés
const BEHIND = 8 * 1024 * 1024;             // a lejátszott részből ennyi marad meg (visszatekeréshez)
const BUDGET = AHEAD + BEHIND + 16 * 1024 * 1024;   // memóriakorlát filmenként
const MAX_RESPONSE = 8 * 1024 * 1024;       // egy válaszban legfeljebb ennyi, a folytatást a böngésző újra kéri
const RETRIES = 3;                          // ennyi sikertelen próba után kap hibát, aki hiányzó részre vár
const FIRST_TIMEOUT = 20000;                // az első válaszra eddig várunk, utána megy a hálózatról
const STALL_TIMEOUT = 20000;                // ha ennyi ideig nem jön adat, újrakezdjük a letöltést
const MAX_EVENT = 4 * 60 * 1000;            // egy válasz legfeljebb eddig tartja életben a háttérprogramot
const IDLE_CLOSE = 2 * 60 * 1000;           // ennyi tétlenség után (bezárt lejátszó) felszabadítjuk
const REFRESH_EVERY = 30000;                // legfeljebb ilyen sűrűn kérünk új linket az oldaltól
const VIDEO_PATH = /\/api\/(stream|proxy_video)$/;

const feeds = new Map();                    // videó URL → Feed (link frissítés után a régi URL is ide mutat)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/* Az oldal új linket adott (Feed.refresh): onnan töltünk tovább, a letöltött rész megmarad */
self.addEventListener('message', (event) => {
    const { type, old, url } = event.data || {};
    const feed = type === 'denjit-refreshed' && url ? feeds.get(old) : null;
    if (!feed || feed.closed) return;
    feed.src = url;
    feeds.set(url, feed);
    feed.failures = 0;
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || !VIDEO_PATH.test(new URL(req.url).pathname)) return;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('Range') || '');
    if (!m) return;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : Infinity;
    event.respondWith(serve(event, req.url, start, end).catch((e) => {
        console.warn('[előretöltés] kimarad, a hálózatról megy:', e?.message || e);
        return fetch(req);
    }));
});

async function serve(event, url, start, end) {
    const feed = feedFor(url);
    feed.seek(start);
    await feed.ready;
    if (start >= feed.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${feed.size}` } });
    }
    // Rövidebb válasz is szabályos: a böngésző a folytatást új kérésként kéri,
    // így egyik esemény sem fut a végtelenségig
    const last = Math.min(feed.size - 1, end, start + MAX_RESPONSE - 1);
    let pos = start;
    let finish;
    event.waitUntil(new Promise((resolve) => {
        finish = resolve;
        setTimeout(resolve, MAX_EVENT);   // ha a böngésző lezáratlanul hagyja a választ
    }));

    const body = new ReadableStream({
        async pull(controller) {
            try {
                const idx = Math.floor(pos / CHUNK);
                const chunk = await feed.get(idx);
                const to = Math.min(chunk.length, last + 1 - idx * CHUNK);
                controller.enqueue(chunk.slice(pos - idx * CHUNK, to));
                pos = idx * CHUNK + to;
                feed.seek(pos);
                if (pos > last) {
                    controller.close();
                    finish();
                }
            } catch (e) {
                controller.error(e);
                finish();
            }
        },
        cancel() { finish(); },
    });

    return new Response(body, {
        status: 206,
        headers: {
            'Content-Type': feed.type,
            'Content-Length': String(last - start + 1),
            'Content-Range': `bytes ${start}-${last}/${feed.size}`,
            'Accept-Ranges': 'bytes',
        },
    });
}

/* Egyszerre egy film: másik videónál a régi előretöltést eldobjuk */
function feedFor(url) {
    let feed = feeds.get(url);
    if (!feed) {
        for (const old of new Set(feeds.values())) old.close();
        feed = new Feed(url);
        feeds.set(url, feed);
    }
    return feed;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Egy videó előretöltése: CHUNK méretű darabok a memóriában, a lejátszó
   pozíciója (pos) előtt AHEAD bájtnyi, mögötte BEHIND bájtnyi */
class Feed {
    constructor(url) {
        this.src = url;                     // innen töltünk (a régi szervernél a token-link frissülhet)
        this.size = null;
        this.type = 'video/mp4';
        this.chunks = new Map();            // darab sorszáma → Uint8Array
        this.waiting = new Map();           // darab sorszáma → [{ resolve, reject }]
        this.pos = 0;                       // eddig adtuk oda a lejátszónak (bájt)
        this.job = null;                    // folyó letöltés: { idx, stop, ctrl, moved }
        this.failures = 0;
        this.closed = false;
        this.error = null;
        this.wake = null;
        this.usedAt = Date.now();
        this.refreshedAt = 0;
        this.ready = new Promise((resolve, reject) => { this.readyOk = resolve; this.readyFail = reject; });
        this.ready.catch(() => {});
        this.run();
    }

    get chunkCount() {
        return this.size === null ? Infinity : Math.ceil(this.size / CHUNK);
    }

    chunkLen(idx) {
        return Math.min(CHUNK, this.size - idx * CHUNK);
    }

    inWindow(idx) {
        return idx >= Math.floor(this.pos / CHUNK) && idx <= Math.floor((this.pos + AHEAD) / CHUNK);
    }

    /* A lejátszó idáig ért, vagy ide tekert: ha a folyó letöltés már nem ide visz, leállítjuk */
    seek(pos) {
        this.pos = pos;
        this.usedAt = Date.now();
        const job = this.job;
        const serves = (w) => this.inWindow(w) && w >= job.idx && w <= job.stop;
        if (job && !this.inWindow(job.idx) && ![...this.waiting.keys()].some(serves)) {
            job.moved = true;
            job.ctrl.abort();
        }
        this.trim();
        this.poke();
    }

    get(idx) {
        this.usedAt = Date.now();
        const chunk = this.chunks.get(idx);
        if (chunk) return Promise.resolve(chunk);
        if (this.error) return Promise.reject(this.error);
        return new Promise((resolve, reject) => {
            if (!this.waiting.has(idx)) this.waiting.set(idx, []);
            this.waiting.get(idx).push({ resolve, reject });
            this.poke();
        });
    }

    store(idx, chunk) {
        this.failures = 0;
        this.chunks.set(idx, chunk);
        for (const w of this.waiting.get(idx) || []) w.resolve(chunk);
        this.waiting.delete(idx);
        this.trim();
    }

    /* Memóriakorlát: előbb a régen lejátszott, aztán a messze előre eső darabok mennek */
    trim() {
        if (this.chunks.size * CHUNK <= BUDGET) return;
        const keepFrom = Math.floor((this.pos - BEHIND) / CHUNK);
        const keepTo = Math.floor((this.pos + AHEAD) / CHUNK);
        const keys = [...this.chunks.keys()];
        const behind = keys.filter((i) => i < keepFrom).sort((a, b) => a - b);
        const beyond = keys.filter((i) => i > keepTo).sort((a, b) => b - a);
        for (const i of [...behind, ...beyond]) {
            if (this.chunks.size * CHUNK <= BUDGET) break;
            this.chunks.delete(i);
        }
    }

    /* A következő letöltendő darab; null, ha van elég előre. Elsőbbség: amire a legutóbbi
       (tekerés utáni) helyen várnak, aztán az előretöltés, végül a régebbi kérések */
    next() {
        const missing = [...this.waiting.keys()].filter((i) => !this.chunks.has(i));
        const near = missing.filter((i) => this.inWindow(i));
        if (near.length) return Math.min(...near);
        const total = this.chunkCount;
        let idx = Math.floor(this.pos / CHUNK);
        while (idx < total && this.chunks.has(idx)) idx++;
        if (idx < total && idx * CHUNK - this.pos < AHEAD - REFILL) return idx;
        return missing.length ? Math.min(...missing) : null;
    }

    /* A szerver elutasította a letöltést (a régi szervernél: lejárt token-link): új linket
       kérünk az oldaltól, az a válaszban (message esemény) adja meg */
    async refresh() {
        if (Date.now() - this.refreshedAt < REFRESH_EVERY) return;
        this.refreshedAt = Date.now();
        for (const client of await self.clients.matchAll({ type: 'window' })) {
            client.postMessage({ type: 'denjit-refresh', url: this.src });
        }
    }

    poke() {
        const wake = this.wake;
        this.wake = null;
        if (wake) wake();
    }

    async run() {
        while (!this.closed) {
            const idx = this.next();
            if (idx === null) {
                await Promise.race([new Promise((resolve) => { this.wake = resolve; }), delay(30000)]);
                if (Date.now() - this.usedAt > IDLE_CLOSE) this.close();
                continue;
            }
            const job = { idx, ctrl: new AbortController(), moved: false };
            this.job = job;
            try {
                await this.download(job);
            } catch (e) {
                if (this.closed) return;
                if (job.moved) continue;   // tekerés: máshonnan kell folytatni
                // Az első kérés hibájánál nem erőltetjük: a lejátszó egyből a hálózatról kapja
                if (this.size === null) return this.close(e);
                if (e.status) this.refresh();
                // A már letöltött rész megmarad, abból megy tovább a lejátszás, közben újrapróbáljuk.
                // Aki a még hiányzó részre vár, néhány sikertelen próba után hibát kap (a lejátszó újratölt).
                if (++this.failures >= RETRIES) this.rejectWaiting(e);
                await delay(Math.min(1000 * this.failures, 10000));
            } finally {
                if (this.job === job) this.job = null;
            }
        }
    }

    /* Egy nagyobb adag letöltése job.idx-től: az ablak végéig, vagy a következő meglévő darabig */
    async download(job) {
        let idx = job.idx;
        let stop = Math.max(idx, Math.floor((this.pos + AHEAD) / CHUNK));
        for (let i = idx + 1; i <= stop; i++) {
            if (this.chunks.has(i)) { stop = i - 1; break; }
        }
        stop = Math.min(stop, this.chunkCount - 1);
        job.stop = stop;

        const timer = this.size === null ? setTimeout(() => job.ctrl.abort(), FIRST_TIMEOUT) : 0;
        let res;
        try {
            res = await fetch(this.src, {
                headers: { Range: `bytes=${idx * CHUNK}-${(stop + 1) * CHUNK - 1}` },
                signal: job.ctrl.signal,
                cache: 'no-store',
            });
        } finally {
            clearTimeout(timer);
        }
        const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('Content-Range') || '');
        if (res.status !== 206 || !m || Number(m[1]) !== idx * CHUNK) {
            throw Object.assign(new Error(`váratlan válasz (${res.status})`), { status: res.status });
        }
        if (this.size === null) {
            this.size = Number(m[3]);
            this.type = res.headers.get('Content-Type') || this.type;
            this.readyOk();
        }
        const end = Number(m[2]);

        const reader = res.body.getReader();
        let buf = new Uint8Array(this.chunkLen(idx));
        let fill = 0;
        let stall = 0;
        try {
            while (idx * CHUNK <= end) {
                clearTimeout(stall);
                stall = setTimeout(() => job.ctrl.abort(), STALL_TIMEOUT);
                const { value, done } = await reader.read();
                if (done) throw new Error('a letöltés idő előtt véget ért');
                let off = 0;
                while (off < value.length && idx * CHUNK <= end) {
                    const n = Math.min(buf.length - fill, value.length - off);
                    buf.set(value.subarray(off, off + n), fill);
                    fill += n;
                    off += n;
                    if (fill < buf.length) continue;
                    this.store(idx, buf);
                    job.idx = ++idx;
                    if (idx * CHUNK > end) break;
                    // Közben máshova tekert: ez a rész már nem kell
                    if (!this.inWindow(idx) && !this.waiting.has(idx)) return;
                    buf = new Uint8Array(this.chunkLen(idx));
                    fill = 0;
                }
            }
        } finally {
            clearTimeout(stall);
            reader.cancel().catch(() => {});
        }
    }

    rejectWaiting(error) {
        for (const list of this.waiting.values()) list.forEach((w) => w.reject(error));
        this.waiting.clear();
    }

    close(error = new Error('az előretöltés leállt')) {
        if (this.closed) return;
        this.closed = true;
        this.error = error;
        this.job?.ctrl.abort();
        this.readyFail(error);
        this.rejectWaiting(error);
        this.chunks.clear();
        for (const [url, feed] of feeds) if (feed === this) feeds.delete(url);
        this.poke();
    }
}
