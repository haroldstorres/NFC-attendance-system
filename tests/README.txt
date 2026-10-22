TAP-IN TESTS

One-time:   npm install        (installs firebase-tools and the rules test library; Java 11+ is needed for the emulator)

npm run test:logic   tap type, SF2 counting, holidays, CSV import, Manila time. No Firebase needed. Runs in a second.
npm run test:rules   security rules (log, kidPhotos, holidays, consents, staff). Starts the Firestore emulator by itself.
npm test             both

The tests read the real index.html, firestore.rules and functions/index.js, so they check exactly what you deploy.
Run them before every deploy. If a test fails after you change the app, either you broke something or the test needs updating on purpose.
Add node_modules/ to .gitignore.
