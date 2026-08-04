const CONFIG = {
    GOOGLE_API_KEY: 'AIzaSyCNMU85XO9QAN81vv-0pinbbKT4cw79sT8',  // User will fill this in
    GOOGLE_CLIENT_ID: '399673854739-5n2sa5lli4o94jfvckd8t7l6r79j93p1.apps.googleusercontent.com', // User will fill this in
    DRIVE_ROOT_FOLDER_ID: '1EMBjhqjnOIUh4fXxcgKK77w3gxnOqVe5',
    CATEGORIES: {
        'Játék': { emoji: '🎮', color: '#34d399' },
        'Film': { emoji: '🎬', color: '#f59e0b' },
        'Sorozat': { emoji: '📺', color: '#818cf8' }
    },
    ADMIN_USERNAME: 'Denji',
    ADMIN_PASSWORD_HASH: 'a0c342dffe8643d009fb8881f5bfe6ec20514666813b024fdd7f385caa7ab607',
    PASSCODES: [
        { id: '1', name: 'Barát', code: '7788', role: 'guest' },
        { id: '2', name: 'Anya', code: '7777', role: 'guest' }
    ],
    CACHE_TTL: 5 * 60 * 1000, // 5 minutes
};
