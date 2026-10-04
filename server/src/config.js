import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const STATE_FILE = path.join(DATA_DIR, 'portfolio.json');

/**
 * 설정 스키마.
 * min/max : 허용 범위
 * step   : UI 입력 간격
 * group  : 설정 다이얼로그의 섹션
 * suffix : UI 표시 단위
 * help   : 설명 문구
 */
export const SCHEMA = {
  // ── 전략 / 손익 ──────────────────────────────────────────────
  takeProfitPct: { min: 0.1, max: 1000, step: 0.1, group: 'strategy', label: '익절률 (Take Profit)', suffix: '%', help: '진입가 대비 이 수익률에 도달하면 즉시 매도합니다.' },
  stopLossPct: { min: 0.1, max: 100, step: 0.1, group: 'strategy', label: '손절률 (Stop Loss)', suffix: '%', help: '진입가 대비 이 손실률에 도달하면 즉시 매도합니다.' },
  trailingStopPct: { min: 0, max: 50, step: 0.1, group: 'strategy', label: '트레일링 스탑', suffix: '%', help: '0 이면 사용 안 함.持仓 중 최고가에서 되돌아오는 폭입니다.' },
  maxHoldMinutes: { min: 0, max: 10080, step: 1, group: 'strategy', label: '최대 보유 시간', suffix: '분', help: '이 시간이 지나면 시가에 무조건 청산합니다. 0 이면 무제한. 보유 중이면 포지션에 남은 시간이 표시됩니다.' },

  // ── RSI 진입 조건 ────────────────────────────────────────────
  useRsiFilter: { min: 0, max: 1, step: 1, group: 'rsi', bool: true, label: 'RSI 조건 사용', suffix: '', help: '거래량 급등을 통과한 종목 중 RSI 가 아래 범위 안에 있을 때만 진입합니다. 끄면 거래량 조건만 봅니다.' },
  rsiPeriod: { min: 2, max: 100, step: 1, group: 'rsi', label: 'RSI 기간', suffix: '봉', help: '1분봉 기준 Wilder 평활 RSI 를 계산합니다. 일반적인 14 를 권장합니다.' },
  rsiMin: { min: 0, max: 100, step: 1, group: 'rsi', label: 'RSI 하한', suffix: '', help: '이 값 미만이면 모멘텀이 약해 진입하지 않습니다. 0 이면 제한 없음.' },
  rsiMax: { min: 0, max: 100, step: 1, group: 'rsi', label: 'RSI 상한', suffix: '', help: '이 값 초과면 과매수로 진입하지 않습니다. 100 이면 제한 없음.' },

  use24hChangeFilter: { min: 0, max: 1, step: 1, group: 'scanner', bool: true, label: '24시간 변동 필터', suffix: '', help: '24h 변동률이 하한 미만인 종목은 진입하지 않습니다. 이미 보유한 포지션의 익절/손절 청산에는 영향을 주지 않습니다.' },
  minChange24hPct: { min: -100, max: 100, step: 0.5, group: 'scanner', label: '최소 24시간 변동률', suffix: '%', help: '0 이면 마이너스로 빠진 종목을 진입 금지합니다. -100 으로 두면 사실상 제한 없음.' },

  // ── 자금 / 포지션 ─────────────────────────────────────────────
  initialCapitalUSDT: { min: 10, max: 100_000_000, step: 10, group: 'money', label: '초기 자본', suffix: 'USDT' },
  positionSizeUSDT: { min: 1, max: 1_000_000, step: 1, group: 'money', label: '종목당 투자 금액', suffix: 'USDT' },
  maxPositions: { min: 1, max: 50, step: 1, group: 'money', label: '최대 동시 보유 종목 수', suffix: '종목' },
  topN: { min: 1, max: 50, step: 1, group: 'money', label: '스캐너가 고를 후보 종목 수', suffix: '종목' },
  cooldownMinutes: { min: 0, max: 1440, step: 5, group: 'money', label: '재진입 쿨다운', suffix: '분', help: '매도한 종목은 이 시간 동안 다시 매수하지 않습니다. 0 이면 해제.' },

  // ── 거래량 급등 탐지 ──────────────────────────────────────────
  scanIntervalSec: { min: 10, max: 600, step: 5, group: 'scanner', label: '스캔 주기', suffix: '초' },
  recentWindowMinutes: { min: 1, max: 30, step: 1, group: 'scanner', label: '최근 구간 (분)', suffix: '분', help: '이 구간의 평균 거래량을 비교 대상(급등)으로 봅니다.' },
  lookbackMinutes: { min: 5, max: 240, step: 5, group: 'scanner', label: '기준 구간 (분)', suffix: '분', help: '최근 구간을 제외한 과거 구간. 이 평균과 비교해 급등을 판정합니다.' },
  zScoreThreshold: { min: 0.5, max: 10, step: 0.1, group: 'scanner', label: 'z-score 임계값', suffix: 'σ', help: '표준편차 단위. 높일수록 엄격한 급등만 선별됩니다.' },
  surgeRatioThreshold: { min: 1, max: 20, step: 0.1, group: 'scanner', label: '급등 배수 임계값', suffix: '배', help: '최근 평균 거래량 ÷ 기준 평균 거래량. z-score와 함께 모두 만족해야 합니다.' },
  minMinuteQuoteVolumeUSDT: { min: 0, max: 500_000_000, step: 50_000, group: 'scanner', label: '최소 분당 거래대금', suffix: 'USDT', help: '최근 구간의 평균 분당 거래대금 기준. 이보다 낮으면 유동성이 부족해 제외합니다. (BTC 기준 대략 150만 USDT/분)' },
  min24hQuoteVolumeUSDT: { min: 0, max: 50_000_000_000, step: 5_000_000, group: 'scanner', label: '최소 24시간 거래대금', suffix: 'USDT', help: '이만큼 거래되는 종목만 추적·진입 대상으로 봅니다.' },
  maxSymbols: { min: 20, max: 500, step: 10, group: 'scanner', label: '히스토리 추적 종목 수', suffix: '종목', help: '거래대금 상위 N개 종목의 1분봉을 메모리에 쌓습니다. 클수록 급등 탐지 범위가 넓어집니다.' },
  minOnboardDays: { min: 0, max: 90, step: 1, group: 'scanner', label: '최소 상장 후 경과일', suffix: '일', help: '신규 상장 종목은 거래량 히스토리가 없어 제외합니다.' },

  // ── 데이터 피드 ─────────────────────────────────────────────
  marketPollSec: { min: 3, max: 120, step: 1, group: 'feed', label: '24시간 시세 갱신 주기', suffix: '초', help: '전체 종목의 24h 거래대금·변동률을 받아오는 간격입니다.' },
  barPollSec: { min: 5, max: 180, step: 5, group: 'feed', label: '1분봉 거래량 갱신 주기', suffix: '초', help: '급등 판정의 근거가 되는 1분봉을 가져오는 간격입니다. 짧을수록 급등 탐지가 빠릅니다.' },

  // ── 비용 ────────────────────────────────────────────────────
  takerFeeBps: { min: 0, max: 20, step: 0.5, group: 'cost', label: '양방향 수수료 (bp)', suffix: 'bp', help: '1bp = 0.01%. 매수·매도 각각 1회씩 적용됩니다. 바이낸스 선물 테이커 5bp 기준.' },
  slippageBps: { min: 0, max: 100, step: 1, group: 'cost', label: '슬리피지 (bp)', suffix: 'bp', help: '체결가에 더해 손해 방향으로 적용되는 비용입니다.' },

  // ── 동작 ────────────────────────────────────────────────────
  autoTrade: { min: 0, max: 1, step: 1, group: 'runtime', label: '자동 매수/매도 실행', suffix: '', bool: true, help: '끄면 후보 종목만 표시하고 매매는 직접 버튼으로만 실행합니다.' },
};

export const DEFAULT_SETTINGS = {
  takeProfitPct: 10,
  stopLossPct: 5,
  trailingStopPct: 0,
  maxHoldMinutes: 0,

  useRsiFilter: 1,
  rsiPeriod: 14,
  rsiMin: 45,
  rsiMax: 75,

  use24hChangeFilter: 1,
  minChange24hPct: 0,

  initialCapitalUSDT: 10_000,
  positionSizeUSDT: 100,
  maxPositions: 10,
  topN: 10,
  cooldownMinutes: 15,

  scanIntervalSec: 60,
  recentWindowMinutes: 3,
  lookbackMinutes: 30,
  zScoreThreshold: 2.0,
  surgeRatioThreshold: 2.0,
  minMinuteQuoteVolumeUSDT: 300_000,
  min24hQuoteVolumeUSDT: 20_000_000,
  maxSymbols: 200,
  minOnboardDays: 7,

  marketPollSec: 10,
  barPollSec: 20,

  takerFeeBps: 5,
  slippageBps: 2,

  autoTrade: 1,
};

export const GROUPS = [
  { id: 'strategy', name: '손익 기준 (익절 / 손절)', desc: '가상 포지션의 청산 규칙입니다.' },
  { id: 'rsi', name: 'RSI 진입 조건', desc: '거래량 급등을 넘어 momentum 을 확인합니다. 1분봉 기준 Wilder 평활 RSI.' },
  { id: 'money', name: '자금 / 포지션', desc: '가상 자금이 실제로 어떻게 움직일지 결정합니다.' },
  { id: 'scanner', name: '거래량 급등 탐지', desc: '"급등"을 어떤 기준으로 판정할지 설정합니다.' },
  { id: 'feed', name: '데이터 피드', desc: '시세·거래량을 가져오는 주기입니다. 짧을수록 실시간성이 좋아집니다.' },
  { id: 'cost', name: '거래 비용', desc: '실거래와 유사하게 수수료와 슬리피지를 반영합니다.' },
  { id: 'runtime', name: '동작', desc: '자동 매매 및 실행 관련 옵션입니다.' },
];

/** 설정값 정규화 + 검증. 유효하지 않은 값은 기본값으로 대체하고, 경고 목록을 반환합니다. */
export function normalizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const out = { ...base };
  const warnings = [];

  for (const [key, def] of Object.entries(SCHEMA)) {
    if (!(key in input)) continue;
    let value = input[key];

    if (def.bool) {
      value = value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
      out[key] = value;
      continue;
    }

    const num = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
    if (!Number.isFinite(num)) {
      warnings.push(`${def.label}: 숫자가 아니어서 기본값(${base[key]})을 사용합니다.`);
      continue;
    }
    if (num < def.min || num > def.max) {
      const clamped = Math.min(def.max, Math.max(def.min, num));
      warnings.push(`${def.label}: 허용 범위(${def.min}~${def.max}) 밖이라 ${clamped}로 조정했습니다.`);
      out[key] = clamped;
      continue;
    }
    out[key] = num;
  }

  // ── 상관관계 검증 ──
  if (out.lookbackMinutes <= out.recentWindowMinutes) {
    out.lookbackMinutes = out.recentWindowMinutes * 2 + 5;
    warnings.push(`기준 구간은 최근 구간보다 커야 합니다. 자동 조정 → ${out.lookbackMinutes}분`);
  }
  const needed = out.recentWindowMinutes + out.lookbackMinutes;
  if (needed > 1000) {
    warnings.push('구간 합이 1000분을 초과합니다. 바이낸스 분봉 최대 1000개 제한에 걸립니다.');
  }
  const totalNeeded = out.maxPositions * out.positionSizeUSDT;
  if (totalNeeded > out.initialCapitalUSDT) {
    warnings.push(`최대 포지션(${out.maxPositions} × ${out.positionSizeUSDT} = ${totalNeeded} USDT)이 초기 자본(${out.initialCapitalUSDT} USDT)보다 큽니다. 자금이 모자라면 매수가 제한됩니다.`);
  }
  if (out.positionSizeUSDT + (out.positionSizeUSDT * out.takerFeeBps) / 10_000 > out.initialCapitalUSDT) {
    warnings.push('종목당 투자 금액(수수료 포함)이 초기 자본보다 큽니다. 매수가 불가능합니다.');
  }

  if (out.rsiMin > out.rsiMax) {
    const fixed = { min: out.rsiMin, max: out.rsiMin };
    warnings.push(`RSI 하한(${out.rsiMin})이 상한(${out.rsiMax})보다 큽니다. 조건을 만족할 수 없으므로 상한을 ${out.rsiMin} 으로 맞췄습니다.`);
    out.rsiMax = fixed.max;
  }
  if (out.useRsiFilter && out.rsiMin === out.rsiMax) {
    warnings.push('RSI 하한과 상한이 같습니다. 정확히 이 값인 종목만 진입하므로 대부분 통과하지 못합니다.');
  }

  return { settings: out, warnings };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return normalizeSettings({ ...raw }).settings;
  } catch (err) {
    console.warn('[config] 설정 파일을 읽지 못해 기본값으로 시작합니다:', err.message);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    ensureDir();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] 설정 저장 실패:', err.message);
  }
}

export function loadPortfolioState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    console.warn('[config] 포트폴리오 상태를 읽지 못했습니다:', err.message);
    return null;
  }
}

export function savePortfolioState(state) {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] 포트폴리오 상태 저장 실패:', err.message);
  }
}
