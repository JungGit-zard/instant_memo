const fs = require('fs');
const path = require('path');
const https = require('https');

const DATABASE_URL = 'https://j-instant-memo-default-rtdb.firebaseio.com/allMemos.json';

function requestJson(method, url, payload) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = https.request({
            method,
            hostname: target.hostname,
            path: `${target.pathname}${target.search}`,
            headers: payload ? { 'Content-Type': 'application/json' } : undefined
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }

                resolve(data ? JSON.parse(data) : null);
            });
        });

        req.on('error', reject);

        if (payload) {
            req.write(JSON.stringify(payload));
        }

        req.end();
    });
}

function hashString(value) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash << 5) - hash) + value.charCodeAt(index);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function getLegacyMemoId(memo, dateKey, index) {
    const createdAt = memo?.createdAt || `${dateKey || 'unknown'}T00:00:00.000Z`;
    const seed = `${dateKey || 'unknown'}|${memo?.text || ''}|${createdAt}|${memo?.carriedFrom || ''}|${index}`;
    return `legacy-${hashString(seed)}`;
}

function normalizeMemo(memo, dateKey, index) {
    const base = memo && typeof memo === 'object' ? memo : {};
    const createdAt = base.createdAt || new Date().toISOString();
    const id = typeof base.id === 'string' && base.id ? base.id : getLegacyMemoId(base, dateKey, index);
    const originId = typeof base.originId === 'string' && base.originId ? base.originId : id;

    return {
        ...base,
        id,
        originId,
        text: typeof base.text === 'string' ? base.text : '',
        completed: Boolean(base.completed),
        createdAt,
        updatedAt: base.updatedAt || createdAt
    };
}

function normalizeMemoMap(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return {};
    }

    const normalized = {};
    Object.entries(data).forEach(([dateKey, bucket]) => {
        normalized[dateKey] = Array.isArray(bucket)
            ? bucket.map((memo, index) => normalizeMemo(memo, dateKey, index)).filter((memo) => memo.text !== '')
            : [];
        sortMemoBucket(normalized[dateKey]);
    });

    return normalized;
}

function sortMemoBucket(bucket) {
    bucket.sort((a, b) => {
        if (a.completed !== b.completed) {
            return a.completed ? 1 : -1;
        }
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
}

function chooseLatest(left, right) {
    if (!left) return right;
    if (!right) return left;

    const leftTime = Date.parse(left.updatedAt || left.createdAt || 0);
    const rightTime = Date.parse(right.updatedAt || right.createdAt || 0);
    return rightTime >= leftTime ? right : left;
}

function getMemoLineageKey(memo) {
    return memo?.originId || memo?.id || '';
}

function isLegacyLineageId(value) {
    return typeof value === 'string' && value.startsWith('legacy-');
}

function createCanonicalLegacyOriginId(memo, dateKey, index) {
    const seed = `${memo?.text || ''}|${memo?.createdAt || ''}|${dateKey || ''}|${index}`;
    return `legacy-origin-${hashString(seed)}`;
}

function compareMemoChronology(left, right) {
    const createdDiff = new Date(left.createdAt) - new Date(right.createdAt);
    if (createdDiff !== 0) return createdDiff;

    const updatedDiff = new Date(left.updatedAt) - new Date(right.updatedAt);
    if (updatedDiff !== 0) return updatedDiff;

    return String(left.id).localeCompare(String(right.id));
}

function dedupeMemoMapByLineage(sourceMap) {
    let changed = false;

    Object.keys(sourceMap).forEach((dateKey) => {
        const bucket = Array.isArray(sourceMap[dateKey]) ? sourceMap[dateKey] : [];
        const bucketByLineage = new Map();

        bucket.forEach((memo) => {
            const lineageKey = getMemoLineageKey(memo) || memo.id;
            bucketByLineage.set(lineageKey, chooseLatest(bucketByLineage.get(lineageKey), memo));
        });

        const dedupedBucket = Array.from(bucketByLineage.values());
        sortMemoBucket(dedupedBucket);

        if (dedupedBucket.length !== bucket.length || JSON.stringify(dedupedBucket) !== JSON.stringify(bucket)) {
            sourceMap[dateKey] = dedupedBucket;
            changed = true;
        }
    });

    return changed;
}

function stabilizeMemoMap(sourceMap) {
    if (!sourceMap || typeof sourceMap !== 'object') {
        return false;
    }

    let changed = false;
    const sortedDates = Object.keys(sourceMap).sort();

    sortedDates.forEach((dateKey) => {
        const bucket = Array.isArray(sourceMap[dateKey]) ? sourceMap[dateKey] : [];

        bucket.forEach((memo, index) => {
            if (!memo.carriedFrom && isLegacyLineageId(memo.originId)) {
                const canonicalOriginId = createCanonicalLegacyOriginId(memo, dateKey, index);
                if (memo.originId !== canonicalOriginId) {
                    memo.originId = canonicalOriginId;
                    changed = true;
                }
            }
        });

        const carryGroups = new Map();
        bucket.forEach((memo, index) => {
            if (!memo.carriedFrom || !isLegacyLineageId(memo.originId)) {
                return;
            }

            const groupKey = `${memo.carriedFrom}\u0000${memo.text}`;
            if (!carryGroups.has(groupKey)) {
                carryGroups.set(groupKey, []);
            }
            carryGroups.get(groupKey).push({ memo, index });
        });

        carryGroups.forEach((entries, groupKey) => {
            const [sourceDate, text] = groupKey.split('\u0000');
            const sourceBucket = Array.isArray(sourceMap[sourceDate]) ? sourceMap[sourceDate] : [];
            const sourceCandidates = sourceBucket
                .filter((memo) => memo.text === text)
                .slice()
                .sort(compareMemoChronology);

            entries
                .slice()
                .sort((left, right) => compareMemoChronology(left.memo, right.memo))
                .forEach((entry, index) => {
                    const sourceMemo = sourceCandidates[Math.min(index, sourceCandidates.length - 1)];
                    const nextOriginId = sourceMemo
                        ? getMemoLineageKey(sourceMemo)
                        : createCanonicalLegacyOriginId(entry.memo, dateKey, entry.index);

                    if (entry.memo.originId !== nextOriginId) {
                        entry.memo.originId = nextOriginId;
                        changed = true;
                    }
                });
        });
    });

    return dedupeMemoMapByLineage(sourceMap) || changed;
}

async function main() {
    const raw = await requestJson('GET', DATABASE_URL);
    const normalized = normalizeMemoMap(raw);
    const beforeToday = (normalized['2026-04-17'] || []).length;
    stabilizeMemoMap(normalized);
    const afterToday = (normalized['2026-04-17'] || []).length;

    const backupDir = path.join(process.cwd(), 'tools', 'memo_backups');
    fs.mkdirSync(backupDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `allMemos_remote_backup_${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2));

    if (process.argv.includes('--write')) {
        await requestJson('PUT', DATABASE_URL, normalized);
    }

    console.log(`backup=${backupPath}`);
    console.log(`today_before=${beforeToday}`);
    console.log(`today_after=${afterToday}`);
    console.log(`write=${process.argv.includes('--write')}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
