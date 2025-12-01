/**
 * Friends Verification Relay API - Vercel Serverless Function
 * 
 * Automatic matchmaking - no codes needed!
 * When both users click "Verify Now" on each other, they get matched.
 * 
 * Actions: request, check, exchange, cancel
 */

// In-memory storage (use Vercel KV for production)
const pendingRequests = new Map(); // key: `${userUuid}:${friendUuid}` -> request data

// Clean expired requests (older than 5 minutes)
function cleanExpired() {
    const now = Date.now();
    for (const [key, request] of pendingRequests) {
        if (now - request.created > 5 * 60 * 1000) {
            pendingRequests.delete(key);
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
            case 'request':
                return handleRequest(req, res, body);
            case 'check':
                return handleCheck(req, res);
            case 'exchange':
                return handleExchange(req, res, body);
            case 'cancel':
                return handleCancel(req, res, body);
            default:
                return res.status(404).json({ error: 'Unknown action' });
        }
    } catch (error) {
        console.error('API Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

/**
 * POST /request
 * Submit a verification request. If the friend has already requested to verify us,
 * we're matched immediately.
 */
function handleRequest(req, res, body) {
    const myUuid = normalizeUuid(body.uuid);
    const myName = body.name || 'Unknown';
    const myPublicKey = body.publicKey;
    const friendUuid = normalizeUuid(body.friendUuid);
    
    if (!myUuid || !myPublicKey || !friendUuid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (myUuid === friendUuid) {
        return res.status(400).json({ error: 'Cannot verify yourself' });
    }
    
    const myKey = `${myUuid}:${friendUuid}`;
    const theirKey = `${friendUuid}:${myUuid}`;
    
    // Store my request
    pendingRequests.set(myKey, {
        uuid: myUuid,
        name: myName,
        publicKey: myPublicKey,
        friendUuid: friendUuid,
        created: Date.now(),
        claim: null
    });
    
    console.log(`[verify] ${myName} (${myUuid}) requesting to verify ${friendUuid}`);
    
    // Check if friend has already requested to verify us
    const theirRequest = pendingRequests.get(theirKey);
    if (theirRequest) {
        console.log(`[verify] Match found! ${myUuid} <-> ${friendUuid}`);
        return res.status(200).json({
            matched: true,
            friendUuid: theirRequest.uuid,
            friendName: theirRequest.name,
            friendPublicKey: theirRequest.publicKey
        });
    }
    
    // No match yet, waiting for friend
    return res.status(200).json({
        matched: false,
        message: 'Waiting for friend to verify you'
    });
}

/**
 * GET /check
 * Check if friend has requested to verify us (polling endpoint)
 */
function handleCheck(req, res) {
    const myUuid = normalizeUuid(req.query.uuid);
    const friendUuid = normalizeUuid(req.query.friendUuid);
    
    if (!myUuid || !friendUuid) {
        return res.status(400).json({ error: 'Missing uuid or friendUuid' });
    }
    
    const theirKey = `${friendUuid}:${myUuid}`;
    const theirRequest = pendingRequests.get(theirKey);
    
    if (theirRequest) {
        // They're also trying to verify us!
        return res.status(200).json({
            matched: true,
            friendUuid: theirRequest.uuid,
            friendName: theirRequest.name,
            friendPublicKey: theirRequest.publicKey,
            friendClaim: theirRequest.claim // May be null if they haven't submitted yet
        });
    }
    
    // Still waiting
    return res.status(200).json({
        matched: false
    });
}

/**
 * POST /exchange
 * Submit signed claim for the friend to retrieve
 */
function handleExchange(req, res, body) {
    const myUuid = normalizeUuid(body.uuid);
    const friendUuid = normalizeUuid(body.friendUuid);
    const signature = body.signature;
    const addedAt = parseInt(body.addedAt) || 0;
    const claimsFriend = body.claimsFriend === 'true' || body.claimsFriend === true;
    
    if (!myUuid || !friendUuid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const myKey = `${myUuid}:${friendUuid}`;
    const myRequest = pendingRequests.get(myKey);
    
    if (!myRequest) {
        return res.status(404).json({ error: 'No pending request found' });
    }
    
    // Store our claim
    myRequest.claim = {
        claimsFriend: claimsFriend,
        signature: signature || '',
        addedAt: addedAt
    };
    
    // Check if friend has submitted their claim
    const theirKey = `${friendUuid}:${myUuid}`;
    const theirRequest = pendingRequests.get(theirKey);
    
    if (theirRequest && theirRequest.claim) {
        // Both have submitted claims - verification complete!
        return res.status(200).json({
            complete: true,
            friendClaim: theirRequest.claim
        });
    }
    
    // Waiting for friend to submit their claim
    return res.status(200).json({
        complete: false,
        message: 'Claim submitted, waiting for friend'
    });
}

/**
 * POST /cancel
 * Cancel a pending verification request
 */
function handleCancel(req, res, body) {
    const myUuid = normalizeUuid(body.uuid);
    const friendUuid = normalizeUuid(body.friendUuid);
    
    if (!myUuid || !friendUuid) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const myKey = `${myUuid}:${friendUuid}`;
    pendingRequests.delete(myKey);
    
    return res.status(200).json({ success: true });
}
