/**
 * Friends Verification & Presence Relay API
 * 
 * Actions: add, check, exchange, remove, presence, getPresence
 * Rate limited to prevent abuse.
 */

// In-memory storage (use Vercel KV for production persistence)
const friendRequests = new Map(); // key: `${userUuid}:${friendUuid}` -> request data
const userPresence = new Map();   // key: uuid -> presence data
const rateLimits = new Map();     // key: uuid -> { count, windowStart }

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const RATE_LIMIT_MAX_REQUESTS = 30; // Max 30 requests per minute per user
const PRESENCE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes = offline

// Clean expired data
function cleanExpired() {
    const now = Date.now();
    for (const [key, request] of friendRequests) {
        if (now - request.created > 24 * 60 * 60 * 1000) {
            friendRequests.delete(key);
        }
    }
    for (const [key, presence] of userPresence) {
        if (now - presence.lastSeen > PRESENCE_TIMEOUT_MS * 2) {
            userPresence.delete(key);
        }
    }
    for (const [key, limit] of rateLimits) {
        if (now - limit.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
            rateLimits.delete(key);
        }
    }
}

function normalizeUuid(uuid) {
    if (!uuid) return '';
    return uuid.replace(/-/g, '').toLowerCase();
}

function checkRateLimit(uuid) {
    if (!uuid) return { allowed: false, remaining: 0 };
    
    const now = Date.now();
    let limit = rateLimits.get(uuid);
    
    if (!limit || now - limit.windowStart > RATE_LIMIT_WINDOW_MS) {
        limit = { count: 1, windowStart: now };
        rateLimits.set(uuid, limit);
        return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
    }
    
    if (limit.count >= RATE_LIMIT_MAX_REQUESTS) {
        return { allowed: false, remaining: 0 };
    }
    
    limit.count++;
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - limit.count };
}

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    cleanExpired();
    
    const { action } = req.query;
    
    // Parse body for POST requests
    let body = {};
    if (req.method === 'POST') {
        if (typeof req.body === 'string') {
            const params = new URLSearchParams(req.body);
            for (const [key, value] of params) {
                body[key] = value;
            }
        } else {
            body = req.body || {};
        }
    }
    
    // Get user UUID for rate limiting
    const userUuid = normalizeUuid(body.uuid || req.query.uuid);
    
    // Check rate limit
    const rateCheck = checkRateLimit(userUuid);
    res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
    
    if (!rateCheck.allowed) {
        return res.status(429).json({ 
            error: 'Rate limit exceeded. Please wait before making more requests.',
            retryAfter: 60
        });
    }
    
    try {
        switch (action) {
            case 'add':
                return handleAdd(req, res, body);
            case 'check':
                return handleCheck(req, res);
            case 'exchange':
                return handleExchange(req, res, body);
            case 'remove':
                return handleRemove(req, res, body);
            case 'presence':
                return handlePresenceUpdate(req, res, body);
            case 'getPresence':
                return handleGetPresence(req, res);
            default:
                return res.status(404).json({ error: 'Unknown action' });
        }
    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * POST /presence
 * Update the user's online presence
 */
function handlePresenceUpdate(req, res, body) {
    const uuid = normalizeUuid(body.uuid);
    const name = body.name || 'Unknown';
    const status = body.status || 'ONLINE';
    const activity = body.activity || 'UNKNOWN';
    const serverAddress = body.serverAddress || null;
    const serverName = body.serverName || null;
    
    if (!uuid) {
        return res.status(400).json({ error: 'Missing uuid' });
    }
    
    userPresence.set(uuid, {
        uuid: uuid,
        name: name,
        status: status,
        activity: activity,
        serverAddress: serverAddress,
        serverName: serverName,
        lastSeen: Date.now()
    });
    
    return res.status(200).json({ success: true });
}

/**
 * GET /getPresence
 * Get presence for one or more friends
 * ?uuid=myUuid&friends=uuid1,uuid2,uuid3
 */
function handleGetPresence(req, res) {
    const myUuid = normalizeUuid(req.query.uuid);
    const friendsParam = req.query.friends || '';
    
    if (!myUuid) {
        return res.status(400).json({ error: 'Missing uuid' });
    }
    
    const friendUuids = friendsParam.split(',').map(u => normalizeUuid(u)).filter(u => u.length > 0);
    const now = Date.now();
    const results = {};
    
    for (const friendUuid of friendUuids) {
        const presence = userPresence.get(friendUuid);
        if (presence && (now - presence.lastSeen < PRESENCE_TIMEOUT_MS)) {
            results[friendUuid] = {
                name: presence.name,
                status: presence.status,
                activity: presence.activity,
                serverAddress: presence.serverAddress,
                serverName: presence.serverName,
                lastSeen: presence.lastSeen
            };
        } else {
            results[friendUuid] = {
                status: 'OFFLINE',
                activity: 'UNKNOWN',
                lastSeen: presence ? presence.lastSeen : 0
            };
        }
    }
    
    return res.status(200).json({ presence: results });
}

/**
 * POST /add
 * Called when a player adds someone as a friend.
 */
function handleAdd(req, res, body) {
    const myUuid = normalizeUuid(body.uuid);
    const myName = body.name || 'Unknown';
    const myPublicKey = body.publicKey;
    const friendUuid = normalizeUuid(body.friendUuid);
    const signature = body.signature || '';
    const addedAt = parseInt(body.addedAt) || Date.now();
    
    if (!myUuid || !myPublicKey || !friendUuid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (myUuid === friendUuid) {
        return res.status(400).json({ error: 'Cannot add yourself' });
    }
    
    const myKey = `${myUuid}:${friendUuid}`;
    const theirKey = `${friendUuid}:${myUuid}`;
    
    friendRequests.set(myKey, {
        uuid: myUuid,
        name: myName,
        publicKey: myPublicKey,
        friendUuid: friendUuid,
        signature: signature,
        addedAt: addedAt,
        created: Date.now()
    });
    
    console.log(`[verify] ${myName} (${myUuid.substring(0,8)}) added ${friendUuid.substring(0,8)} as friend`);
    
    const theirRequest = friendRequests.get(theirKey);
    if (theirRequest) {
        console.log(`[verify] Mutual match! ${myUuid.substring(0,8)} <-> ${friendUuid.substring(0,8)}`);
        return res.status(200).json({
            matched: true,
            friendUuid: theirRequest.uuid,
            friendName: theirRequest.name,
            friendPublicKey: theirRequest.publicKey,
            friendSignature: theirRequest.signature,
            friendAddedAt: theirRequest.addedAt
        });
    }
    
    return res.status(200).json({
        matched: false,
        message: 'Friend request stored. Waiting for them to add you back.'
    });
}

/**
 * GET /check
 * Check if any friends have added us back
 */
function handleCheck(req, res) {
    const myUuid = normalizeUuid(req.query.uuid);
    const friendUuid = req.query.friendUuid ? normalizeUuid(req.query.friendUuid) : null;
    
    if (!myUuid) {
        return res.status(400).json({ error: 'Missing uuid' });
    }
    
    if (friendUuid) {
        const theirKey = `${friendUuid}:${myUuid}`;
        const theirRequest = friendRequests.get(theirKey);
        
        if (theirRequest) {
            return res.status(200).json({
                matched: true,
                friendUuid: theirRequest.uuid,
                friendName: theirRequest.name,
                friendPublicKey: theirRequest.publicKey,
                friendSignature: theirRequest.signature,
                friendAddedAt: theirRequest.addedAt
            });
        }
        
        return res.status(200).json({ matched: false });
    }
    
    const matches = [];
    for (const [key, request] of friendRequests) {
        if (key.endsWith(':' + myUuid)) {
            const theirUuid = key.split(':')[0];
            const ourKey = `${myUuid}:${theirUuid}`;
            if (friendRequests.has(ourKey)) {
                matches.push({
                    friendUuid: request.uuid,
                    friendName: request.name,
                    friendPublicKey: request.publicKey,
                    friendSignature: request.signature,
                    friendAddedAt: request.addedAt
                });
            }
        }
    }
    
    return res.status(200).json({ matches: matches });
}

/**
 * POST /exchange
 */
function handleExchange(req, res, body) {
    const myUuid = normalizeUuid(body.uuid);
    const friendUuid = normalizeUuid(body.friendUuid);
    const signature = body.signature;
    const addedAt = parseInt(body.addedAt) || 0;
    
    if (!myUuid || !friendUuid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const myKey = `${myUuid}:${friendUuid}`;
    const myRequest = friendRequests.get(myKey);
    
    if (myRequest) {
        myRequest.signature = signature;
        myRequest.addedAt = addedAt;
    }
    
    return res.status(200).json({ success: true });
}

/**
 * POST /remove
 */
function handleRemove(req, res, body) {
    const myUuid = normalizeUuid(body.uuid);
    const friendUuid = normalizeUuid(body.friendUuid);
    
    if (!myUuid || !friendUuid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const myKey = `${myUuid}:${friendUuid}`;
    friendRequests.delete(myKey);
    
    console.log(`[verify] ${myUuid.substring(0,8)} removed ${friendUuid.substring(0,8)}`);
    
    return res.status(200).json({ success: true });
}
