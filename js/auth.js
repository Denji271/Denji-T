/**
 * Denji-T · Belépés és belépőkódok
 */

const USER_KEY = 'denjit_user';
const PASSCODES_KEY = 'denjit_passcodes';

// SHA-256 a Web Crypto API-val
async function hashPassword(password) {
    const bytes = new TextEncoder().encode(password);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const codeOf = (p) => String(p?.code ?? '').trim();

// Kódlista: CONFIG.PASSCODES + a localStorage-ban tároltak (a config nyer ütközéskor)
function getPasscodes() {
    const configCodes = Array.isArray(CONFIG?.PASSCODES) ? CONFIG.PASSCODES : [];
    let localCodes = [];
    try {
        localCodes = JSON.parse(localStorage.getItem(PASSCODES_KEY)) || [];
    } catch (e) {
        console.error('Failed to parse passcodes:', e);
    }

    const combined = [...configCodes];
    for (const item of localCodes) {
        if (!combined.some(p => codeOf(p) === codeOf(item))) combined.push(item);
    }
    for (const item of combined) {
        if (codeOf(item) === '7777') item.name = 'Anya';
    }
    return combined;
}

function savePasscodes(passcodes) {
    localStorage.setItem(PASSCODES_KEY, JSON.stringify(passcodes));
}

// Kód hozzáadása vagy felülírása
function addPasscode(name, code, role = 'guest') {
    const passcodes = getPasscodes();
    const cleanCode = code.trim();
    const existing = passcodes.findIndex(p => codeOf(p) === cleanCode);
    if (existing >= 0) {
        passcodes[existing] = { id: passcodes[existing].id, name, code: cleanCode, role };
    } else {
        passcodes.push({ id: Date.now().toString(), name, code: cleanCode, role });
    }
    savePasscodes(passcodes);
    return passcodes;
}

function deletePasscode(id) {
    const passcodes = getPasscodes().filter(p => p.id !== id);
    savePasscodes(passcodes);
    return passcodes;
}

// Munkamenet mentése — „maradjak bejelentkezve” esetén az eszközön is megmarad
function saveSession(user, remember) {
    const data = JSON.stringify(user);
    sessionStorage.setItem(USER_KEY, data);
    if (remember) localStorage.setItem(USER_KEY, data);
    else localStorage.removeItem(USER_KEY);
}

// Belépés admin felhasználónévvel + jelszóval
async function loginWithPassword(username, password, remember = false) {
    if (username === CONFIG.ADMIN_USERNAME && await hashPassword(password) === CONFIG.ADMIN_PASSWORD_HASH) {
        const user = { username: 'Denji', displayName: 'Denji', role: 'admin' };
        saveSession(user, remember);
        return { success: true, user };
    }
    return { success: false, error: 'Hibás felhasználónév vagy jelszó!' };
}

// Belépés belépőkóddal
function loginWithPasscode(code, remember = false) {
    const cleanCode = code.trim();
    if (!cleanCode) return { success: false, error: 'Add meg a kódot!' };

    const found = getPasscodes().find(p => codeOf(p) === cleanCode);
    if (!found) return { success: false, error: 'Érvénytelen belépési kód!' };

    const user = { username: found.name, displayName: found.name, role: found.role || 'guest', code: cleanCode };
    saveSession(user, remember);
    return { success: true, user };
}

// Belépett felhasználó (munkamenet → „maradjak bejelentkezve” tároló)
function getCurrentUser() {
    const data = sessionStorage.getItem(USER_KEY) || localStorage.getItem(USER_KEY);
    if (!data) return null;
    try {
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

function isLoggedIn() {
    return !!getCurrentUser();
}

function isAdmin() {
    return getCurrentUser()?.role === 'admin';
}

// A 7777-es kód (Anya) csak a magyar tartalmakat látja
function is7777User() {
    const user = getCurrentUser();
    if (!user) return false;
    return String(user.code) === '7777' ||
        user.username === 'Anya' ||
        user.displayName === 'Anya' ||
        user.username === 'Magyar Barát';
}

function logout() {
    sessionStorage.removeItem(USER_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.reload();
}
