/**
 * Authentication & Passcode Module for Denji-T
 */

// SHA-256 hash using Web Crypto API
async function hashPassword(password) {
    const msgUint8 = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// Get passcodes list (CONFIG.PASSCODES + localStorage)
function getPasscodes() {
    const configCodes = (typeof CONFIG !== 'undefined' && Array.isArray(CONFIG.PASSCODES)) ? CONFIG.PASSCODES : [];
    let localCodes = [];
    const stored = localStorage.getItem('denjit_passcodes');
    if (stored) {
        try {
            localCodes = JSON.parse(stored);
        } catch (e) {
            console.error('Failed to parse passcodes:', e);
        }
    }
    
    const combined = [...configCodes];
    for (const item of localCodes) {
        if (!combined.some(p => p.code.trim() === item.code.trim())) {
            combined.push(item);
        }
    }
    for (const item of combined) {
        if (item.code.trim() === '7777') {
            item.name = 'Anya';
        }
    }
    if (combined.length === 0) {
        combined.push({ id: '1', name: 'Barát', code: '7788', role: 'guest' });
        combined.push({ id: '2', name: 'Anya', code: '7777', role: 'guest' });
    }
    return combined;
}

// Save passcodes list
function savePasscodes(passcodes) {
    localStorage.setItem('denjit_passcodes', JSON.stringify(passcodes));
}

// Add or update a passcode
function addPasscode(name, code, role = 'guest') {
    const passcodes = getPasscodes();
    const cleanCode = code.trim();
    const existingIndex = passcodes.findIndex(p => p.code.trim() === cleanCode);
    if (existingIndex >= 0) {
        passcodes[existingIndex] = { id: passcodes[existingIndex].id, name, code: cleanCode, role };
    } else {
        passcodes.push({ id: Date.now().toString(), name, code: cleanCode, role });
    }
    savePasscodes(passcodes);
    return passcodes;
}

// Delete a passcode
function deletePasscode(id) {
    let passcodes = getPasscodes();
    passcodes = passcodes.filter(p => p.id !== id);
    savePasscodes(passcodes);
    return passcodes;
}

// Login with Admin Username + Password
async function loginWithPassword(username, password) {
    if (username === CONFIG.ADMIN_USERNAME) {
        const hashedPassword = await hashPassword(password);
        if (hashedPassword === CONFIG.ADMIN_PASSWORD_HASH) {
            const user = { username: 'Denji', displayName: 'Denji (Admin)', role: 'admin' };
            sessionStorage.setItem('denjit_user', JSON.stringify(user));
            return { success: true, user };
        }
    }
    return { success: false, error: 'Hibás felhasználónév vagy jelszó!' };
}

// Login with Passcode
function loginWithPasscode(code) {
    const cleanCode = code.trim();
    if (!cleanCode) return { success: false, error: 'Add meg a kódot!' };

    const passcodes = getPasscodes();
    const found = passcodes.find(p => p.code.trim() === cleanCode);
    if (found) {
        const user = { username: found.name, displayName: found.name, role: found.role || 'guest', code: cleanCode };
        sessionStorage.setItem('denjit_user', JSON.stringify(user));
        return { success: true, user };
    }
    return { success: false, error: 'Érvénytelen belépési kód!' };
}

// Legacy login wrapper for backward compatibility
async function login(username, password) {
    const res = await loginWithPassword(username, password);
    return res.success;
}

// Get current logged in user
function getCurrentUser() {
    const data = sessionStorage.getItem('denjit_user');
    if (!data) return null;
    try {
        return JSON.parse(data);
    } catch (e) {
        return null;
    }
}

// Check if user is logged in
function isLoggedIn() {
    return !!getCurrentUser();
}

// Check if logged in user is admin
function isAdmin() {
    const user = getCurrentUser();
    return user && user.role === 'admin';
}

// Check if logged in user is 7777 passcode user (Anya)
function is7777User() {
    const user = getCurrentUser();
    if (!user) return false;
    return (
        user.code === '7777' ||
        String(user.code) === '7777' ||
        user.username === 'Anya' ||
        user.displayName === 'Anya' ||
        user.username === 'Magyar Barát'
    );
}

// Logout
function logout() {
    sessionStorage.removeItem('denjit_user');
    window.location.reload();
}
