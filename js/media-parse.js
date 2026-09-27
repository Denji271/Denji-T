/**
 * Denji-T · Felismerés
 * Streamtape linklisták (bemásolt szöveg vagy .txt) bontása évadokra és részekre,
 * feliratfájlok részhez rendelése és nyelvük felismerése. Az űrlap, a Drive-olvasás
 * és a lejátszó is ezt használja, így mindhárom hely ugyanúgy dönt.
 */

const MEDIA_EXT_RE = /\.(mp4|mkv|avi|webm|mov|m4v|ts|flv|wmv|mpe?g|srt|vtt|ass|ssa|sub|txt)$/i;
const SUB_EXT_RE = /\.(srt|vtt|ass|ssa)$/i;
const LINK_RE = /https?:\/\/[^\s"'<>|]+/gi;
// Elválasztó: minden, ami nem betű vagy szám (az ékezetes betűk is betűnek számítanak)
const SEP = '[^\\p{L}\\p{N}]';

const pad2 = (n) => String(n).padStart(2, '0');
const stripExtension = (name) => String(name || '').replace(MEDIA_EXT_RE, '');

function safeDecode(str) {
    try {
        return decodeURIComponent(str);
    } catch (e) {
        return str;
    }
}

/* ============================================================
   NYELVEK
   ============================================================ */

/* A `names` a fájlnevekben előforduló jelölések (kisbetűvel) */
const SUB_LANGUAGES = [
    { code: 'hu', label: 'Magyar', names: ['hu', 'hun', 'hungarian', 'magyar'] },
    { code: 'en', label: 'Angol', names: ['en', 'eng', 'english', 'angol'] },
    { code: 'de', label: 'Német', names: ['de', 'ger', 'deu', 'german', 'deutsch', 'nemet', 'német'] },
    { code: 'fr', label: 'Francia', names: ['fr', 'fre', 'fra', 'french', 'francais', 'français', 'francia'] },
    { code: 'es', label: 'Spanyol', names: ['es', 'spa', 'esp', 'spanish', 'espanol', 'español', 'spanyol', 'latino'] },
    { code: 'it', label: 'Olasz', names: ['it', 'ita', 'italian', 'italiano', 'olasz'] },
    { code: 'pt', label: 'Portugál', names: ['pt', 'por', 'br', 'ptbr', 'portuguese', 'portugues', 'português', 'brazilian', 'portugal', 'portugál'] },
    { code: 'ro', label: 'Román', names: ['ro', 'rum', 'ron', 'romanian', 'romana', 'română'] },
    { code: 'pl', label: 'Lengyel', names: ['pl', 'pol', 'polish', 'polski', 'lengyel'] },
    { code: 'cs', label: 'Cseh', names: ['cs', 'cz', 'cze', 'ces', 'czech', 'cesky', 'český', 'cseh'] },
    { code: 'sk', label: 'Szlovák', names: ['sk', 'slk', 'slovak', 'slovensky', 'szlovak', 'szlovák'] },
    { code: 'hr', label: 'Horvát', names: ['hr', 'hrv', 'croatian', 'hrvatski', 'horvat', 'horvát'] },
    { code: 'sr', label: 'Szerb', names: ['sr', 'srp', 'scc', 'serbian', 'srpski', 'szerb'] },
    { code: 'ru', label: 'Orosz', names: ['ru', 'rus', 'russian', 'orosz'] },
    { code: 'uk', label: 'Ukrán', names: ['ukr', 'ukrainian', 'ukran', 'ukrán'] },
    { code: 'tr', label: 'Török', names: ['tr', 'tur', 'turkish', 'turkce', 'türkçe', 'torok', 'török'] },
    { code: 'ja', label: 'Japán', names: ['ja', 'jp', 'jpn', 'japanese', 'japan', 'japán'] },
    { code: 'ko', label: 'Koreai', names: ['ko', 'kor', 'korean', 'koreai'] },
    { code: 'zh', label: 'Kínai', names: ['zh', 'chi', 'zho', 'chs', 'cht', 'chinese', 'kinai', 'kínai'] },
    { code: 'nl', label: 'Holland', names: ['nl', 'dut', 'nld', 'dutch', 'holland'] },
    { code: 'sv', label: 'Svéd', names: ['sv', 'swe', 'swedish', 'sved', 'svéd'] },
    { code: 'da', label: 'Dán', names: ['da', 'dan', 'danish', 'dán'] },
    { code: 'no', label: 'Norvég', names: ['no', 'nor', 'nob', 'norwegian', 'norveg', 'norvég'] },
    { code: 'fi', label: 'Finn', names: ['fi', 'fin', 'finnish', 'finn'] },
    { code: 'el', label: 'Görög', names: ['el', 'gre', 'ell', 'greek', 'gorog', 'görög'] },
    { code: 'bg', label: 'Bolgár', names: ['bg', 'bul', 'bulgarian', 'bolgar', 'bolgár'] },
    { code: 'sl', label: 'Szlovén', names: ['sl', 'slv', 'slovenian', 'szloven', 'szlovén'] },
    { code: 'ar', label: 'Arab', names: ['ar', 'ara', 'arabic', 'arab'] },
    { code: 'he', label: 'Héber', names: ['he', 'heb', 'hebrew', 'heber', 'héber'] },
];
const SUB_LANG_UNKNOWN = 'und';

const LANG_BY_NAME = new Map();
SUB_LANGUAGES.forEach(l => l.names.forEach(n => LANG_BY_NAME.set(n, l.code)));

/* A nyelvjelölés után/előtt gyakran álló, nem nyelvet jelentő szavak */
const SUB_MODIFIERS = new Set(['forced', 'sdh', 'hi', 'cc', 'full', 'default', 'sub', 'subs', 'subtitle',
    'subtitles', 'felirat', 'feliratok', 'text', 'track', 'und', 'la', 'lat', '419']);

const langLabel = (code) => SUB_LANGUAGES.find(l => l.code === code)?.label || 'Felirat';

/**
 * Nyelv a fájlnévből. A rövid kódok (hu, en, de…) csak a név végén számítanak —
 * „Show.S01E02.hu.srt” —, különben egy címben álló „It” vagy „De” is nyelvnek látszana.
 */
function subtitleNameInfo(name) {
    const tokens = stripExtension(name).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    let lang = null;
    const forced = tokens.includes('forced');
    // SDH / CC: hallássérülteknek szóló felirat (zajok, zene leírása is benne van)
    let sdh = tokens.includes('sdh');
    for (let i = tokens.length - 1; i >= 0; i--) {
        const tok = tokens[i];
        const hit = LANG_BY_NAME.get(tok);
        if (hit) {
            lang = lang || hit;
            continue;
        }
        if (tok === 'cc' || tok === 'hi') sdh = true;
        if (SUB_MODIFIERS.has(tok) || /^\d{1,3}$/.test(tok)) continue;
        break;
    }
    // A magyar jelölés bárhol állhat — címben gyakorlatilag nem fordul elő
    if (!lang && tokens.some(t => t === 'magyar' || t === 'hungarian' || t === 'hun')) lang = 'hu';
    return { lang, forced, sdh };
}

/* Gyakori, egymástól jól elkülönülő szavak nyelvenként */
const LANG_WORDS = Object.fromEntries(Object.entries({
    hu: 'és hogy nem egy meg van csak már mit most igen vagy volt lesz kell nincs mert ezt azt itt ott nekem neked valami miért mindig semmi tudom köszönöm akkor még sem lehet vagyok vele neki kérlek rendben nagyon jól',
    en: "the you and is to what that it of this have don't i'm are was we know not with for just your me my he she can will there right yeah okay it's you're",
    de: 'und ich nicht das ist du die der es sie wir ein zu was mit mir auf ja den dich sich noch auch hier wie aber mein bin hast',
    fr: "je pas le la les vous est et que tu un une ce il qui ne ça mais pour suis moi bien oui avec sais tout rien c'est",
    es: 'que no el la es y los en lo un por qué me se con para una está bien yo sí pero las eso esto muy tengo',
    it: 'che non di il è la un per mi sono ma ti cosa lo ho si con questo bene gli io sei della hai',
    pt: 'que não o é você a um eu se para uma com do está isso os mas ele sim bem muito vou fazer',
    ro: 'și nu să este de că la ce pe o eu un mai cu asta ești bine sunt da am te ai',
    pl: 'nie się to jest że na co w i z tak ja do mi jak ale już czy jestem go tu',
    cs: 'je to se na že co ne ale jsem tak jak už mi jsi být ano jo tady proč',
    sk: 'je to sa na že čo nie ale som tak ako už mi si byť áno tu prečo',
    hr: 'je da ne se to i u sam što na ti nije mi ali kako si bi ovo ga',
    tr: 'bir bu ve ne için ben sen çok mi da de var değil evet hayır ama o şey gibi',
}).map(([code, words]) => [code, new Set(words.split(' '))]));

/* Csak egy-egy nyelvre jellemző betűk — ezek erősebben számítanak */
const LANG_CHARS = {
    hu: /[őűŐŰ]/g,
    ro: /[șțăȘȚĂ]/g,
    pl: /[łąęśźżŁĄĘŚŹŻ]/g,
    cs: /[řěůŘĚŮ]/g,
    sk: /[ľĺŕôĽĹŔ]/g,
    tr: /[ğıİĞş]/g,
    de: /ß/g,
    es: /[ñ¿¡Ñ]/g,
    pt: /[ãõÃÕ]/g,
    fr: /[œêèÊ]/g,
};

/**
 * A felirat szövegének nyelve (kód), vagy null, ha nem egyértelmű.
 * Írásrendszer alapján (cirill, japán, koreai, kínai), egyébként gyakori szavak alapján.
 */
function detectTextLanguage(text) {
    const body = String(text || '')
        .replace(/^\d+\s*$/gm, ' ')
        .replace(/\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->.*$/gm, ' ')
        .replace(/<[^>]*>|\{[^}]*\}/g, ' ')
        .slice(0, 60000);

    const count = (re) => (body.match(re) || []).length;
    const kana = count(/[぀-ヿ]/g);
    if (kana > 20) return 'ja';
    if (count(/[가-힯]/g) > 20) return 'ko';
    if (count(/[一-鿿]/g) > 20) return 'zh';
    if (count(/[Ѐ-ӿ]/g) > 40) {
        if (count(/[іїєґІЇЄҐ]/g) > 5) return 'uk';
        if (count(/[ђјљњћџЂЈЉЊЋЏ]/g) > 5) return 'sr';
        return 'ru';
    }

    const words = body.toLowerCase().replace(/[’`]/g, "'").split(/[^\p{L}']+/u).filter(Boolean).slice(0, 5000);
    if (words.length < 8) return null;

    const scores = Object.keys(LANG_WORDS).map(code => {
        const set = LANG_WORDS[code];
        let score = 0;
        for (const w of words) if (set.has(w)) score++;
        if (LANG_CHARS[code]) score += Math.min(count(LANG_CHARS[code]), words.length) * 2;
        return { code, score };
    }).sort((a, b) => b.score - a.score);

    const [best, second] = scores;
    if (best.score < 6 || best.score < second.score * 1.25) return null;
    return best.code;
}

/* ---------------- Szövegfájlok dekódolása ---------------- */

/* Ezeknek a nyelveknek a régi, nem UTF-8 feliratai jellemzően Windows-1250 kódolásúak */
const CE_LANGS = new Set(['hu', 'cs', 'sk', 'pl', 'ro', 'hr', 'sr']);

/**
 * Bájtok → szöveg. UTF-8 / UTF-16 (BOM alapján) az elsődleges; ha a fájl nem érvényes UTF-8,
 * a nyelve dönt: Windows-1250 (magyar, cseh…) vagy Windows-1252 (angol, német, francia…).
 */
function decodeText(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
        const ce = new TextDecoder('windows-1250').decode(bytes);
        const lang = detectTextLanguage(ce);
        return (!lang || CE_LANGS.has(lang)) ? ce : new TextDecoder('windows-1252').decode(bytes);
    }
}

/* ============================================================
   ÉVAD / RÉSZ FELISMERÉS
   ============================================================ */

/**
 * Évad és rész egy fájlnévből vagy szövegből. Ami nem derül ki, az null.
 * Felismeri: S01E02, Season 1 Episode 2, 1x02, „1. évad 2. rész”, S01, E05, „5. rész”.
 */
function detectEpisode(input) {
    const str = String(input || '');
    const num = (v) => parseInt(v, 10);
    let m;

    // S01E02, s1e2, S01.E02, S01 - E02, S01EP02, Season 1 Episode 2
    m = str.match(new RegExp(`(?:^|${SEP})s(?:eason)?[\\s._-]*(\\d{1,2})[\\s._-]*(?:e|ep|episode)[\\s._-]*(\\d{1,4})(?!\\d)`, 'iu'));
    if (m) return { season: num(m[1]), episode: num(m[2]) };

    // 1. évad 2. rész, 1.evad.2.resz, 1_évad_02_rész
    m = str.match(/(\d{1,2})\s*\.?[\s._-]*(?:évad|evad)[\s._:,-]*(\d{1,4})\s*\.?[\s._-]*(?:rész|resz|epizód|epizod|ep)/iu)
        || str.match(/(?:évad|evad)[\s._:-]*(\d{1,2})[\s._,;-]*(?:rész|resz|epizód|epizod)[\s._:-]*(\d{1,4})/iu);
    if (m) return { season: num(m[1]), episode: num(m[2]) };

    // 1x02 — az 1920x1080-hoz hasonló felbontásokat a határok kizárják
    m = str.match(new RegExp(`(?:^|${SEP})(\\d{1,2})x(\\d{2,3})(?![\\p{L}\\p{N}])`, 'iu'));
    if (m) return { season: num(m[1]), episode: num(m[2]) };

    let season = null;
    let episode = null;

    m = str.match(new RegExp(`(?:^|${SEP})(?:s(\\d{1,2})|(?:season|évad|evad)[\\s._:-]*(\\d{1,2}))(?!\\d)`, 'iu'))
        || str.match(new RegExp(`(?:^|${SEP})(\\d{1,2})\\s*\\.?[\\s._-]*(?:évad|evad|season)(?!\\p{L})`, 'iu'));
    if (m) season = num(m[1] || m[2]);

    m = str.match(new RegExp(`(?:^|${SEP})(?:e(\\d{1,4})|(?:ep|episode|epizód|epizod|rész|resz)[\\s._:#-]*(\\d{1,4}))(?!\\d)`, 'iu'))
        || str.match(new RegExp(`(?:^|${SEP})(\\d{1,4})\\s*\\.?[\\s._-]*(?:rész|resz|epizód|epizod|episode)(?!\\p{L})`, 'iu'));
    if (m) episode = num(m[1] || m[2]);

    return { season, episode };
}

/**
 * Jelölés nélküli sorszám a fájlnévből: „[Csoport] Bleach - 05 [1080p].mkv”, „Naruto.05.mp4”.
 * A zárójeles részek, a minőségjelölések és az évszámok nem számítanak; a legutolsó szám nyer.
 */
function bareEpisodeNumber(name) {
    const cleaned = stripExtension(safeDecode(String(name || '')))
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
        .replace(/(?:^|[^\p{L}\p{N}])(?:[hx][\s.]?26[45]|\d{3,4}[pi]|\d{1,2}[\s.-]?bit)(?![\p{L}\p{N}])/giu, ' ')
        .replace(/(?:^|[^\d])\d\.\d(?!\d)/g, ' ');           // 5.1, 2.0 hangsáv
    const tokens = cleaned.split(/[\s._\-–—,+#]+/).filter(Boolean);
    for (let i = tokens.length - 1; i >= 0; i--) {
        const m = tokens[i].match(/^(\d{1,4})(?:v\d)?$/i);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        if (m[1].length === 4 && n >= 1900 && n <= 2099) continue;   // évszám
        return n;
    }
    return null;
}

/* Rész egy feliratfájl nevéből (S01E02 → 1/2, „Show - 05.srt” → null/5) */
function subtitleEpisode(name) {
    const base = stripExtension(name);
    const info = detectEpisode(base);
    if (info.episode === null) info.episode = bareEpisodeNumber(base);
    return info;
}

/**
 * Cím a fájlnévből: minden, ami az évad/rész jelölés, évszám vagy minőség előtt áll.
 * Sorozatnál a cím végi sorszám is levágandó („Naruto 05”), filmnél nem („Mob Psycho 100”).
 */
function guessTitle(name, { series = false } = {}) {
    let s = stripExtension(safeDecode(String(name || ''))).replace(/[_.]+/g, ' ');
    s = s.replace(/^\s*(?:\[[^\]]*\]\s*|\([^)]*\)\s*)+/, '');       // [Csoport] az elején
    const markers = [
        's\\d{1,2}\\s*e\\d', 's\\d{1,2}(?!\\d)', 'season\\s*\\d', '\\d{1,2}x\\d{2}',
        '\\d{1,2}\\s*\\.?\\s*(?:évad|evad)', 'e\\d{1,4}(?![\\p{L}\\d])', 'ep\\s*\\d',
        '(?:19|20)\\d{2}(?!\\d)', '\\d{3,4}p', '[\\[(]', '-\\s*\\d{1,4}(?![\\p{L}\\d])',
    ];
    if (series) markers.push('\\d{1,4}\\s*$');
    const cut = s.search(new RegExp(`(?:^|[\\s-])(?:${markers.join('|')})`, 'iu'));
    if (cut === 0) return '';
    if (cut > 0) s = s.slice(0, cut);
    s = s.replace(/\s{2,}/g, ' ').replace(/[\s\-–:]+$/, '').trim();
    return s.length >= 2 && !/^(https?|www|streamtape|video|index|file|download|felirat)$/i.test(s) ? s : '';
}

/* ============================================================
   STREAMTAPE LINKEK
   ============================================================ */

/* A Streamtape sok tükördomainen fut (streamtape.to, strtape.cloud, shavetape…),
   mindegyiken /v/AZONOSÍTÓ, /e/AZONOSÍTÓ (vagy /r/AZONOSÍTÓ) formában. */
function streamtapeParts(url) {
    let u;
    try {
        u = new URL(String(url || '').trim());
    } catch (e) {
        return null;
    }
    if (!/tape|streamta\.pe|strcloud|scloud/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/[ver]\/([A-Za-z0-9]+)(\/[^?#]*)?/);
    if (!m) return null;
    const rest = m[2] || '';
    return { id: m[1], rest, name: safeDecode(rest.replace(/^\/+/, '').split('/').pop() || '') };
}

const isStreamtapeUrl = (url) => !!streamtapeParts(url);

/* Egységes, beágyazható alak: https://streamtape.com/e/AZONOSÍTÓ/fájlnév */
function normalizeStreamUrl(url) {
    const clean = String(url || '').trim();
    const st = streamtapeParts(clean);
    return st ? `https://streamtape.com/e/${st.id}${st.rest}` : clean;
}

/* A linket körülvevő zárójelek, idézőjelek és írásjelek levágása */
function trimUrlPunctuation(url) {
    let clean = url.replace(/^[<"'({\[]+/, '').replace(/[>,."');}\]!?]+$/, '');
    if (clean.endsWith(')') && !clean.includes('(')) clean = clean.slice(0, -1);
    if (clean.endsWith(']') && !clean.includes('[')) clean = clean.slice(0, -1);
    return clean;
}

/* HTML / BBCode exportból sima „link név” sorok — minden link külön sorba kerül */
function normalizeLinkMarkup(text) {
    return String(text || '')
        .replace(/\r\n?/g, '\n')
        .replace(/<br\s*\/?>|<\/(?:p|li|div|tr)>/gi, '\n')
        .replace(/\[url=["']?([^\]"']+)["']?\]([\s\S]*?)\[\/url\]/gi, '\n$1 $2\n')
        .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, '\n$1\n')
        .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '\n$1 $2\n')
        .replace(/<(?:iframe|video|source|embed)\b[^>]*?src\s*=\s*["']([^"']+)["'][^>]*>/gi, '\n$1\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&');
}

/* „streamtape.com/v/…” protokoll nélkül is linknek számít */
const addMissingProtocol = (line) =>
    line.replace(/(^|[^\/\w.@-])((?:www\.)?(?:[a-z0-9-]*tape[a-z0-9-]*\.[a-z]{2,}|streamta\.pe)\/[ver]\/)/gi, '$1https://$2');

const lastPathSegment = (url) => {
    try {
        return safeDecode(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    } catch (e) {
        return '';
    }
};

/* Szövegsor linkek nélkül, ami csak évadot jelöl: „2. évad”, „=== Season 3 ===” */
function seasonHeaderOf(line) {
    const info = detectEpisode(line);
    if (info.season === null || info.episode !== null) return null;
    const digits = line.replace(/(?:19|20)\d{2}/g, '').match(/\d+/g) || [];
    return digits.length === 1 ? info.season : null;
}

/**
 * Linklista → évadok és részek.
 * Bemenet: bármilyen szöveg (Streamtape export, .txt, HTML/BBCode/beágyazó kód, kézi lista).
 * A részt a sor szövege, a link fájlneve, a fájlnévben álló sorszám, végül a sorrend dönti el.
 */
function parseStreamLinks(rawText) {
    const entries = [];
    for (const raw of normalizeLinkMarkup(rawText).split('\n')) {
        const line = addMissingProtocol(raw.trim());
        if (!line) continue;
        const urls = line.match(LINK_RE) || [];
        if (!urls.length) {
            const season = seasonHeaderOf(line);
            entries.push(season !== null ? { kind: 'header', season } : { kind: 'text', text: line });
            continue;
        }
        urls.forEach(u => entries.push({
            kind: 'url',
            url: trimUrlPunctuation(u),
            own: urls.length === 1 ? line.replace(u, ' ').replace(/^[\s:|;,\-–]+|[\s:|;,\-–]+$/g, '') : ''
        }));
    }

    // A linkhez tartozó név a link előtti vagy utáni sorban állhat — az első pár dönti el
    const firstUrl = entries.findIndex(e => e.kind === 'url');
    const nameAfter = firstUrl >= 0 && entries[firstUrl + 1]?.kind === 'text' && entries[firstUrl - 1]?.kind !== 'text';

    let headerSeason = null;
    let items = [];
    entries.forEach((e, i) => {
        if (e.kind === 'header') headerSeason = e.season;
        if (e.kind !== 'url') return;
        let label = e.own;
        if (!label) {
            const near = entries[nameAfter ? i + 1 : i - 1];
            if (near?.kind === 'text') label = near.text;
        }
        items.push({ url: e.url, label, headerSeason });
    });

    // Ha van Streamtape link, a többi (bélyegkép, weboldal…) csak zaj
    const total = items.length;
    if (items.some(it => isStreamtapeUrl(it.url))) items = items.filter(it => isStreamtapeUrl(it.url));
    const ignored = total - items.length;

    const seen = new Set();
    let title = '';
    let fallbackTitle = '';
    const detected = [];
    for (const it of items) {
        const url = normalizeStreamUrl(it.url);
        const key = streamtapeParts(url)?.id || url;
        if (seen.has(key)) continue;
        seen.add(key);

        const st = streamtapeParts(url);
        const fileName = st ? st.name : lastPathSegment(url);
        const fromLabel = detectEpisode(it.label);
        const fromName = detectEpisode(stripExtension(fileName));
        const season = fromLabel.season ?? fromName.season ?? it.headerSeason;
        const episode = fromLabel.episode ?? fromName.episode ?? bareEpisodeNumber(fileName) ?? bareEpisodeNumber(it.label);
        // A címet lehetőleg olyan fájlnévből vesszük, amiben rész-jelölés is van (nem pl. „intro.mp4”)
        const marked = [fromLabel, fromName].some(x => x.season !== null || x.episode !== null);
        const guess = guessTitle(fileName, { series: true }) || guessTitle(it.label, { series: true });
        if (marked && !title) title = guess;
        if (!fallbackTitle) fallbackTitle = guess;
        detected.push({ url, name: fileName || it.label, season, episode });
    }
    title = title || fallbackTitle;

    // Évad nélküli linkek: az 1. évadba kerülnek
    detected.forEach(d => { if (d.season === null) d.season = 1; });

    // Ismert részek előbb; a sorszám nélküliek az évad utolsó része után, a sorrendjük szerint
    const bySeason = new Map();
    let duplicates = 0;
    let guessed = 0;
    const put = (d, ep) => {
        if (!bySeason.has(d.season)) bySeason.set(d.season, new Map());
        const eps = bySeason.get(d.season);
        if (eps.has(ep)) {
            duplicates++;
            return;
        }
        eps.set(ep, { ep, url: d.url, name: d.name });
    };
    detected.filter(d => d.episode !== null).forEach(d => put(d, d.episode));
    detected.filter(d => d.episode === null).forEach(d => {
        const eps = bySeason.get(d.season);
        const next = eps?.size ? Math.max(...eps.keys()) + 1 : 1;
        guessed++;
        put(d, next);
    });

    const seasons = [...bySeason.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([season, eps]) => ({
            season,
            episodes: [...eps.values()].sort((a, b) => a.ep - b.ep)
        }));

    return {
        seasons,
        title,
        linkCount: seasons.reduce((n, s) => n + s.episodes.length, 0),
        ignored,
        duplicates,
        guessed
    };
}

/* ============================================================
   FELIRATOK
   ============================================================ */

/* Az .ass/.ssa feliratot a lejátszó nem ismeri, feltöltéskor .srt lesz belőle */
function assToSrt(text) {
    const toMs = (t) => {
        const m = String(t || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
        if (!m) return null;
        const frac = parseInt(m[4].padEnd(3, '0'), 10);
        return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + frac;
    };
    const fmt = (ms) => {
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms % 1000).padStart(3, '0')}`;
    };

    let inEvents = false;
    let format = null;
    const cues = [];
    for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
        const t = line.trim();
        if (/^\[.+\]$/.test(t)) {
            inEvents = /^\[events\]$/i.test(t);
            continue;
        }
        if (!inEvents) continue;
        if (/^format\s*:/i.test(t)) {
            format = t.replace(/^format\s*:/i, '').split(',').map(s => s.trim().toLowerCase());
            continue;
        }
        const m = t.match(/^dialogue\s*:\s*(.*)$/i);
        if (!m || !format) continue;

        const textIdx = format.indexOf('text');
        const parts = m[1].split(',');
        const body = parts.slice(textIdx).join(',');
        if (/\\p[1-9]/.test(body)) continue;   // rajzolt feliratelem, nem szöveg
        const start = toMs(parts[format.indexOf('start')]);
        const end = toMs(parts[format.indexOf('end')]);
        // A dőlt betűt megtartjuk (a lejátszó ismeri), a többi stílusjelölés elhagyható
        const clean = body
            .replace(/\{([^}]*)\}/g, (_, tags) => (/\\i1/.test(tags) ? '<i>' : '') + (/\\i0/.test(tags) ? '</i>' : ''))
            .replace(/\\N/g, '\n').replace(/\\[nh]/g, ' ').trim();
        if (start === null || end === null || !clean.replace(/<\/?i>/g, '').trim()) continue;
        cues.push({ start, end, text: clean });
    }

    cues.sort((a, b) => a.start - b.start);
    return cues.map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

/* Egységes Drive fájlnév: S01E02.hu.srt, filmnél felirat.hu.srt */
function subtitleDriveName({ season, episode, lang, forced, sdh, ext, dup = 1 }) {
    const parts = [(season != null && episode != null) ? `S${pad2(season)}E${pad2(episode)}` : 'felirat'];
    if (dup > 1) parts.push(String(dup));
    if (lang && lang !== SUB_LANG_UNKNOWN) parts.push(lang);
    if (forced) parts.push('forced');
    if (sdh) parts.push('sdh');
    return `${parts.join('.')}.${ext}`;
}

/* Menüfeliratok: „Magyar”, „Angol (SDH)”, azonos nyelvnél „Magyar 2” */
function subtitleLabels(subs) {
    const seen = new Map();
    return subs.map(sub => {
        const info = subtitleNameInfo(sub.name);
        let label = info.lang ? langLabel(info.lang) : 'Felirat';
        if (info.forced) label += ' (forced)';
        if (info.sdh) label += ' (SDH)';
        const n = (seen.get(label) || 0) + 1;
        seen.set(label, n);
        return n > 1 ? `${label} ${n}` : label;
    });
}
