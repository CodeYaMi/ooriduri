import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskKey } from './binance/private.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.COIN_SURFER_DATA_DIR || path.join(__dirname, '..', 'data');
// 레거시 단일 파일 (마이그레이션 전 데이터용 폴백)
const LEGACY_DIR = DATA_DIR;

const credFile = (dir) => path.join(dir, 'credentials.json');
const liveFlagFile = (dir) => path.join(dir, 'live-armed.json');

/**
 * API 자격증명 저장소 (계정별 디렉터리 기준).
 *
 * 보안 정책
 *  - apiSecret 은 절대 클라이언트로 전송하지 않는다 (마스킹만 전달)
 *  - 파일 권한 600 (소유자만 읽기/쓰기)
 *  - 로그에 시크릿을 남기지 않는다
 *  - 실거래 활성 플래그는 재시작 시 자동으로 해제된다
 */

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writePrivate(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 파일시스템이 권한 변경을 지원하지 않을 수 있음 */
  }
}

/** 자격증명 저장 */
export function saveCredentials(dir, { apiKey, apiSecret, network }) {
  const creds = {
    apiKey: String(apiKey).trim(),
    apiSecret: String(apiSecret).trim(),
    network: network === 'production' ? 'production' : 'testnet',
    savedAt: Date.now(),
  };
  writePrivate(credFile(dir), creds);
  return creds;
}

export function loadCredentials(dir) {
  try {
    const file = credFile(dir);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw?.apiKey || !raw?.apiSecret) return null;
    return raw;
  } catch (err) {
    console.warn('[credentials] 파일을 읽을 수 없습니다:', err.message);
    return null;
  }
}

export function hasCredentials(dir) {
  return Boolean(loadCredentials(dir));
}

export function deleteCredentials(dir) {
  try {
    const file = credFile(dir);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (err) {
    console.error('[credentials] 삭제 실패:', err.message);
    return false;
  }
}

/** 클라이언트에 전달할 안전한 상태 (시크릿 없음) */
export function describeCredentials(dir) {
  const creds = loadCredentials(dir);
  if (!creds) {
    return { connected: false, network: null, apiKeyMasked: null, savedAt: null, liveArmed: false };
  }
  const flag = readLiveFlag(dir);
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

// ── 실거래 무장 플래그 (계정별) ───────────────────────────────

export function readLiveFlag(dir) {
  try {
    const file = liveFlagFile(dir);
    if (!fs.existsSync(file)) return { armed: false, network: null, at: null };
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { armed: false, network: null, at: null };
  }
}

/** 실거래 모드 무장 — 사용자가 명시적으로 확인해야만 true */
export function armLive(dir, network) {
  writePrivate(liveFlagFile(dir), { armed: true, network, at: Date.now() });
  return { armed: true, network, at: Date.now() };
}

export function disarmLive(dir) {
  try {
    const file = liveFlagFile(dir);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (err) {
    console.error('[credentials] 실거래 플래그 해제 실패:', err.message);
  }
  return { armed: false };
}

/**
 * 서버 기동 시 호출 — 모든 계정의 실거래 무장을 해제한다.
 * (의도치 않은 재시작 후 자동 매수로 실제 손실이 나는 것을 막는다)
 * @param {string[]} dirs 계정 디렉터리 목록 (레거시 포함)
 */
export function resetLiveOnBoot(dirs = [LEGACY_DIR]) {
  let wasArmed = false;
  for (const dir of dirs) {
    if (readLiveFlag(dir).armed) {
      disarmLive(dir);
      wasArmed = true;
    }
  }
  if (wasArmed) {
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

export { DATA_DIR };
