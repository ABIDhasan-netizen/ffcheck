# FF Nexus — Free Fire UID Checker + API

## Render-এ ডিপ্লয় (সহজ পথ)
1. এই ফোল্ডার GitHub-এ একটা নতুন repo হিসেবে আপলোড করুন।
2. render.com → New → Web Service → repo সিলেক্ট করুন।
3. Build Command: `npm install` | Start Command: `npm start`
4. Environment-এ `.env.example` এর ভ্যালুগুলো বসান (JWT_SECRET অবশ্যই লম্বা র‍্যান্ডম দিন, UPSTREAM_URL আপনার API)।
5. ইউজার ডেটা যেন না হারায়: Disks → Add Disk → mount path `/data`, আর `DB_PATH=/data/app.db` দিন (পেইড)।

## লোকালি চালান
npm install && cp .env.example .env && node --env-file=.env server.js

## UPSTREAM_URL
আপনার ডেটা সোর্স API-র লিংক বসান, UID জায়গায় `{uid}` আর রিজিয়নের জায়গায় `{region}` লিখুন।
কোনো key দরকার হলে UPSTREAM_HEADERS-এ দিন: {"x-api-key":"..."}
