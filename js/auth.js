/**
 * Authentication module for Denji-T
 */

// SHA-256 hash using Web Crypto API
async function hashPassword(password) {
    const msgUint8 = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

// Validates credentials against CONFIG and stores login state
async function login(username, password) {
    if (username === CONFIG.ADMIN_USERNAME) {
        const hashedPassword = await hashPassword(password);
        if (hashedPassword === CONFIG.ADMIN_PASSWORD_HASH) {
            sessionStorage.setItem('denjit_auth', 'true');
            return true;
        }
    }
    return false;
}

// Clears sessionStorage and reloads the page
function logout() {
    sessionStorage.removeItem('denjit_auth');
    window.location.reload();
}

// Checks if the user is currently logged in
function isLoggedIn() {
    return sessionStorage.getItem('denjit_auth') === 'true';
}

// Checks if the user is an admin (same as logged in for this app)
function isAdmin() {
    return isLoggedIn();
}
