<?php
/**
 * Friends Verification Relay API
 * Deploy to: https://minecraftoldschool.com/api/friends/verify/
 * 
 * Endpoints:
 * POST /session/create - Create a verification session, returns a code
 * POST /session/join   - Join a session with a code
 * GET  /session/status - Check if peer has joined
 * POST /session/claim  - Submit friendship claim
 * GET  /session/claims - Get peer's claim
 * POST /session/complete - Cleanup session
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

// Simple file-based session storage (use Redis/DB in production)
$SESSION_DIR = '/tmp/mcose_verify_sessions/';
if (!is_dir($SESSION_DIR)) {
    mkdir($SESSION_DIR, 0755, true);
}

$path = $_SERVER['PATH_INFO'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// Clean expired sessions (older than 5 minutes)
foreach (glob($SESSION_DIR . '*.json') as $file) {
    if (filemtime($file) < time() - 300) {
        unlink($file);
    }
}

function generateCode() {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars
    $code = '';
    for ($i = 0; $i < 6; $i++) {
        $code .= $chars[random_int(0, strlen($chars) - 1)];
    }
    return $code;
}

function loadSession($code) {
    global $SESSION_DIR;
    $file = $SESSION_DIR . strtoupper($code) . '.json';
    if (file_exists($file)) {
        return json_decode(file_get_contents($file), true);
    }
    return null;
}

function saveSession($code, $data) {
    global $SESSION_DIR;
    $file = $SESSION_DIR . strtoupper($code) . '.json';
    file_put_contents($file, json_encode($data));
}

function deleteSession($code) {
    global $SESSION_DIR;
    $file = $SESSION_DIR . strtoupper($code) . '.json';
    if (file_exists($file)) {
        unlink($file);
    }
}

// Route handling
if ($path === '/session/create' && $method === 'POST') {
    $uuid = $_POST['uuid'] ?? '';
    $name = $_POST['name'] ?? 'Unknown';
    $publicKey = $_POST['publicKey'] ?? '';
    
    if (empty($uuid) || empty($publicKey)) {
        echo json_encode(['error' => 'Missing required fields']);
        exit;
    }
    
    // Generate unique code
    do {
        $code = generateCode();
    } while (loadSession($code) !== null);
    
    $session = [
        'code' => $code,
        'created' => time(),
        'host' => [
            'uuid' => $uuid,
            'name' => $name,
            'publicKey' => $publicKey,
            'claim' => null
        ],
        'peer' => null,
        'status' => 'waiting'
    ];
    
    saveSession($code, $session);
    echo json_encode(['code' => $code]);
    
} elseif ($path === '/session/join' && $method === 'POST') {
    $code = strtoupper($_POST['code'] ?? '');
    $uuid = $_POST['uuid'] ?? '';
    $name = $_POST['name'] ?? 'Unknown';
    $publicKey = $_POST['publicKey'] ?? '';
    
    if (empty($code) || empty($uuid) || empty($publicKey)) {
        echo json_encode(['error' => 'Missing required fields']);
        exit;
    }
    
    $session = loadSession($code);
    if (!$session) {
        echo json_encode(['error' => 'Invalid or expired code']);
        exit;
    }
    
    if ($session['peer'] !== null) {
        echo json_encode(['error' => 'Session already has a peer']);
        exit;
    }
    
    // Don't allow joining your own session
    if ($session['host']['uuid'] === $uuid) {
        echo json_encode(['error' => 'Cannot join your own session']);
        exit;
    }
    
    $session['peer'] = [
        'uuid' => $uuid,
        'name' => $name,
        'publicKey' => $publicKey,
        'claim' => null
    ];
    $session['status'] = 'joined';
    saveSession($code, $session);
    
    echo json_encode([
        'success' => true,
        'peerUuid' => $session['host']['uuid'],
        'peerName' => $session['host']['name'],
        'peerPublicKey' => $session['host']['publicKey']
    ]);
    
} elseif ($path === '/session/status' && $method === 'GET') {
    $code = strtoupper($_GET['code'] ?? '');
    
    $session = loadSession($code);
    if (!$session) {
        echo json_encode(['status' => 'expired']);
        exit;
    }
    
    if ($session['peer'] !== null) {
        echo json_encode([
            'status' => 'joined',
            'peerUuid' => $session['peer']['uuid'],
            'peerName' => $session['peer']['name'],
            'peerPublicKey' => $session['peer']['publicKey']
        ]);
    } else {
        echo json_encode(['status' => 'waiting']);
    }
    
} elseif ($path === '/session/claim' && $method === 'POST') {
    $code = strtoupper($_POST['code'] ?? '');
    $uuid = $_POST['uuid'] ?? '';
    $claimsPeer = $_POST['claimsPeer'] === 'true';
    $signature = $_POST['signature'] ?? '';
    $addedAt = intval($_POST['addedAt'] ?? 0);
    
    $session = loadSession($code);
    if (!$session) {
        echo json_encode(['error' => 'Invalid session']);
        exit;
    }
    
    $claim = [
        'claimsPeer' => $claimsPeer,
        'signature' => $signature,
        'addedAt' => $addedAt
    ];
    
    if ($session['host']['uuid'] === $uuid) {
        $session['host']['claim'] = $claim;
    } elseif ($session['peer'] && $session['peer']['uuid'] === $uuid) {
        $session['peer']['claim'] = $claim;
    } else {
        echo json_encode(['error' => 'Not a participant']);
        exit;
    }
    
    saveSession($code, $session);
    echo json_encode(['success' => true]);
    
} elseif ($path === '/session/claims' && $method === 'GET') {
    $code = strtoupper($_GET['code'] ?? '');
    $uuid = $_GET['uuid'] ?? '';
    
    $session = loadSession($code);
    if (!$session) {
        echo json_encode(['error' => 'Invalid session']);
        exit;
    }
    
    // Determine who is asking and return the other's claim
    $peerClaim = null;
    if ($session['host']['uuid'] === $uuid && $session['peer'] && $session['peer']['claim']) {
        $peerClaim = $session['peer']['claim'];
    } elseif ($session['peer'] && $session['peer']['uuid'] === $uuid && $session['host']['claim']) {
        $peerClaim = $session['host']['claim'];
    }
    
    if ($peerClaim) {
        echo json_encode([
            'peerClaimsYou' => $peerClaim['claimsPeer'] ? 'true' : 'false',
            'peerSignature' => $peerClaim['signature'],
            'peerAddedAt' => strval($peerClaim['addedAt'])
        ]);
    } else {
        echo json_encode(['waiting' => true]);
    }
    
} elseif ($path === '/session/complete' && $method === 'POST') {
    $code = strtoupper($_POST['code'] ?? '');
    deleteSession($code);
    echo json_encode(['success' => true]);
    
} else {
    http_response_code(404);
    echo json_encode(['error' => 'Not found']);
}

