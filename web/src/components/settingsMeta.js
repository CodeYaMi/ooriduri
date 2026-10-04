/** SettingsModal 렌더링 순서를 정의하는 그룹 목록 */
export const GROUPS_HINT = [
  { id: 'strategy', name: '손익 기준 (익절 / 손절)', desc: '가상 포지션의 청산 규칙입니다.' },
  { id: 'rsi', name: 'RSI 진입 조건', desc: '거래량 급등을 넘어 모멘텀을 확인합니다. 1분봉 기준 Wilder 평활 RSI.' },
  { id: 'money', name: '자금 / 포지션', desc: '가상 자금이 실제로 어떻게 움직일지 결정합니다.' },
  { id: 'scanner', name: '거래량 급등 탐지', desc: '"급등"을 어떤 기준으로 판정할지 설정합니다.' },
  { id: 'feed', name: '데이터 피드', desc: '시세·거래량을 가져오는 주기입니다. 짧을수록 실시간성이 좋아집니다.' },
  { id: 'cost', name: '거래 비용', desc: '실거래와 유사하게 수수료와 슬리피지를 반영합니다.' },
  { id: 'runtime', name: '동작', desc: '자동 매매 및 실행 관련 옵션입니다.' },
];

export const isBoolField = (def) => Boolean(def?.bool);
