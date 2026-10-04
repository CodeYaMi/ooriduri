import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskKey } from './binance/private.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CRED_FILE = path.join(DATA_DIR, 'credentials.json');
const LIVE_FLAG_FILE = path.join(DATA_DIR, 'live-armed.json');

/**
 * API 자격증명 저장소.
 *
 * 보안 정책
 *  - apiSecret 은 절대 클라이언트로 전송하지 않는다 (마스킹만 전달)
 *  - 파일 권한 600 (소유자만 읽기/쓰기)
 *  - 로그에 시크릿을 남기지 않는다
 *  - 실거래 활성 플래그는 재시작 시 자동으로 해제된다
 */

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function writePrivate(file, data) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 파일시스템이 권한 변경을 지원하지 않을 수 있음 */
  }
}

/** 자격증명 저장 */
export function saveCredentials({ apiKey, apiSecret, network }) {
  const creds = {
    apiKey: String(apiKey).trim(),
    apiSecret: String(apiSecret).trim(),
    network: network === 'production' ? 'production' : 'testnet',
    savedAt: Date.now(),
  };
  writePrivate(CRED_FILE, creds);
  return creds;
}

export function loadCredentials() {
  try {
    if (!fs.existsSync(CRED_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (!raw?.apiKey || !raw?.apiSecret) return null;
    return raw;
  } catch (err) {
    console.warn('[credentials] 파일을 읽을 수 없습니다:', err.message);
    return null;
  }
}

export function hasCredentials() {
  return Boolean(loadCredentials());
}

export function deleteCredentials() {
  try {
    if (fs.existsSync(CRED_FILE)) fs.unlinkSync(CRED_FILE);
    return true;
  } catch (err) {
    console.error('[credentials] 삭제 실패:', err.message);
    return false;
  }
}

/** 클라이언트에 전달할 안전한 상태 (시크릿 없음) */
export function describeCredentials() {
  const creds = loadCredentials();
  if (!creds) {
    return { connected: false, network: null, apiKeyMasked: null, savedAt: null, liveArmed: false };
  }
  const flag = readLiveFlag();
  return {
    connected: true,
    network: creds.network,
    apiKeyMasked: maskKey(creds.apiKey),
    savedAt: creds.savedAt,
    keyLength: creds.apiKey.length,
    // 실거래는 '무장' 상태이며, 재시작하면 자동으로 해제된다
    liveArmed: flag.armed && flag.network === creds.network,
  };
}

// ── 실거래 무장 플래그 ────────────────────────────────────────

function readLiveFlag() {
  try {
    if (!fs.existsSync(LIVE_FLAG_FILE)) return { armed: false, network: null, at: null };
    return JSON.parse(fs.readFileSync(LIVE_FLAG_FILE, 'utf8'));
  } catch {
    return { armed: false, network: null, at: null };
  }
}

/** 실거래 모드 무장 — 사용자가 명시적으로 확인해야만 true */
export function armLive(network) {
  writePrivate(LIVE_FLAG_FILE, { armed: true, network, at: Date.now() });
  return { armed: true, network, at: Date.now() };
}

export function disarmLive() {
  try {
    if (fs.existsSync(LIVE_FLAG_FILE)) fs.unlinkSync(LIVE_FLAG_FILE);
  } catch (err) {
    console.error('[credentials] 실거래 플래그 해제 실패:', err.message);
  }
  return { armed: false };
}

/**
 * 서버 기동 시 호출 — 재시작하면 실거래가 자동으로 해제된다.
 * (의도치 않은 재시작 후 자동 매수로 실제 손실이 나는 것을 막는다)
 */
export function resetLiveOnBoot() {
  const wasArmed = readLiveFlag().armed;
  if (wasArmed) {
    disarmLive();
    console.log('[security] 서버 재시작 감지 → 실거래 모드를 자동으로 해제했습니다.');
  }
  return wasArmed;
}

/**
 * 이 전환에 사용자 확인이 필요한가?
 *
 * - paper      : 확인 불필요 (주문 자체가 없음)
 * - live + dryRun : 확인 불필요 (주문을 넣지 않음) ← 안전하게 점검이 목적이므로 즉시 진입
 * - live + 실제주문 : 확인 필수 (실제 자금 이동)
 *
 * 이 구분이 잘못되면 안전 모드가 성의 없이 막히거나,
 * 반대로 위험 모드가 통과될 수 있으므로 테스트로 고정한다.
 */
export function requiresConfirmation({ mode, dryRun }) {
  return mode === 'live' && !dryRun;
}

export { CRED_FILE };
