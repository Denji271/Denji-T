const CONFIG = {
    GOOGLE_API_KEY: 'AIzaSyCNMU85XO9QAN81vv-0pinbbKT4cw79sT8',
    GOOGLE_CLIENT_ID: '399673854739-5n2sa5lli4o94jfvckd8t7l6r79j93p1.apps.googleusercontent.com',
    DRIVE_ROOT_FOLDER_ID: '1EMBjhqjnOIUh4fXxcgKK77w3gxnOqVe5',
    /* A reklámmentes lejátszást a server.py végzi. Üresen hagyva az oldal saját
       eredetét használja (helyi futtatás, vagy ha a server.py szolgálja ki az oldalt).
       GitHub Pages esetén ide jön a szerveren (Oracle Cloud) futó server.py HTTPS címe, záró / nélkül.
       Ha üres és nem localhoston fut, a lejátszó egyből a beágyazott (reklámos) módra vált. */
    API_BASE: 'https://130-61-173-154.sslip.io',
    // A kategórianevek egyben a Drive-mappák nevei is.
    CATEGORIES: ['Játék', 'Film', 'Sorozat'],
    ADMIN_USERNAME: 'Denji',
    ADMIN_PASSWORD_HASH: '5c80565db6f29da0b01aa12522c37b32f121cbe47a861ef7f006cb22922dffa1',
    PASSCODES: [
        { id: '1', name: 'Barát', code: '7788', role: 'guest' },
        { id: '2', name: 'Anya', code: '7777', role: 'guest' }
    ],
    CACHE_TTL: 5 * 60 * 1000, // 5 perc
};
