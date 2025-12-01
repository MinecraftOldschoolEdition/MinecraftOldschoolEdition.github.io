/**
 * Friends Verification Relay API - Fully Automatic
 * 
 * When both players add each other as friends, verification happens automatically.
 * No manual "Verify Now" button needed!
 * 
 * Actions: add, check, exchange, remove
 */

// In-memory storage (use Vercel KV for production persistence)
const friendRequests = new Map(); // key: `${userUuid}:${friendUuid}` -> request data

// Clean expired requests (older than 24 hours)
function cleanExpired() {
    const now = Date.now();
    for (const [key, request] of friendRequests) {
        if (now - request.created > 24 * 60 * 60 * 1000) {
            friendRequests.delete(key);
        }
    }
}

function normalizeUuid(uuid) {
    if (!uuid) return '';
    return uuid.replace(/-/g, '').toLowerCase();
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
            default:
                return res.status(404).json({ error: 'Unknown action' });
        }
    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * POST /add
 * Called when a player adds someone as a friend.
 * Stores the friend request with signature for later verification.
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
    
    // Store my friend request
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
    
    // Check if they've also added us - instant match!
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
    
    // No match yet
    return res.status(200).json({
        matched: false,
        message: 'Friend request stored. Waiting for them to add you back.'
    });
}

/**
 * GET /check
 * Check if any friends have added us back (polling endpoint)
 * Can check for a specific friend or all pending
 */
function handleCheck(req, res) {
    const myUuid = normalizeUuid(req.query.uuid);
    const friendUuid = req.query.friendUuid ? normalizeUuid(req.query.friendUuid) : null;
    
    if (!myUuid) {
        return res.status(400).json({ error: 'Missing uuid' });
    }
    
    // If checking specific friend
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
    
    // Check all - find any friends who have added us back
    const matches = [];
    for (const [key, request] of friendRequests) {
        // Key format is "theirUuid:myUuid" - they added us
        if (key.endsWith(':' + myUuid)) {
            const theirUuid = key.split(':')[0];
            // Check if we also added them
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
    
    return res.status(200).json({
        matches: matches
    });
}

/**
 * POST /exchange
 * Update our signature after verification completes locally
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
 * Remove a friend request (when unfriending)
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
