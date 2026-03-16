const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'anime-list-full.json');
const REMOTE_URL =
    'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const TIMEOUT_MS = 60_000;

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const response = await axios.get(REMOTE_URL, {
        timeout: TIMEOUT_MS,
        responseType: 'arraybuffer',
        headers: {
            'User-Agent': 'StremioSubMaker/1.0',
            Accept: 'application/json',
        },
    });

    const parsed = JSON.parse(Buffer.from(response.data).toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Downloaded anime list is empty or invalid');
    }

    fs.writeFileSync(OUTPUT_FILE, response.data);
    const sizeMB = (response.data.length / (1024 * 1024)).toFixed(1);
    console.log(`Updated ${OUTPUT_FILE} with ${parsed.length} entries (${sizeMB} MB)`);
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
