# Unwrap — 서비스 분석용 Chrome Extension 설계 문서

> 기존 웹 서비스를 분석하여 **QA 테스트 케이스 생성** 및 **재구축**에 활용하기 위한 Chrome Extension 설계 문서.

---

## 1. 목표

- 실제 사용자가 사이트를 사용하는 흐름을 **세션 단위**로 캡처
- 네비게이션, URL, 스크린샷, 네트워크, 소스코드, DOM, 사용자 인터랙션을 시간순으로 기록
- 캡처 데이터를 가공하여:
  - Playwright/Cypress 형태의 **QA 테스트 스크립트 생성**
  - **재구축용 자산** (HTML/CSS/JS, mock 서버 응답) 추출

---

## 2. 아키텍처 개요

### 2.1 Manifest V3 구성요소

```
manifest.json
├── background (service worker)   세션 관리, debugger API 제어
├── content_script                DOM 캡처, 사용자 인터랙션 감지
├── devtools_page + panel         상세 검사 UI
├── side_panel                    세션 컨트롤 (시작/정지/내보내기)
└── offscreen document            대용량 IndexedDB 처리 (선택)
```

### 2.2 핵심 기술 결정

| 결정 | 선택 | 이유 |
|---|---|---|
| 네트워크 캡처 방식 | `chrome.debugger` + CDP Network 도메인 | `chrome.webRequest`는 응답 본문 접근 불가 (MV3 제약) |
| 스크린샷 | 뷰포트는 `tabs.captureVisibleTab`, 풀페이지는 CDP `Page.captureScreenshot` | 풀페이지가 필요한 경우만 debugger 사용 |
| 스토리지 | 메타데이터: `chrome.storage`, 바이너리/대용량: IndexedDB | 쿼터 및 성능 고려 |
| 내보내기 | HAR + 세션 JSON + 미디어 zip | 표준 도구와 호환 |

> **트레이드오프**: `chrome.debugger` 사용시 "DevTools가 이 탭을 디버깅 중입니다" 배너가 노출됨. QA 분석 도구라면 허용 가능한 비용.

---

## 3. 데이터 수집 매핑

| 수집 항목 | API / 방법 |
|---|---|
| 네비게이션 / URL 변경 | `chrome.webNavigation.onCommitted` + `onHistoryStateUpdated` (SPA 대응) |
| 스크린샷 (뷰포트) | `chrome.tabs.captureVisibleTab` |
| 스크린샷 (전체페이지) | CDP `Page.captureScreenshot { captureBeyondViewport: true }` |
| HTTP 요청/응답 본문 | CDP `Network.*` 이벤트 + `Network.getResponseBody` |
| WebSocket / SSE | CDP `Network.webSocketFrameSent / Received` |
| HTML 소스 | content script: `document.documentElement.outerHTML` |
| JS / CSS 소스 | `Network.responseReceived` → body 저장 |
| 콘솔 로그 / 에러 | CDP `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` |
| 사용자 액션 (클릭/입력) | content script 이벤트 위임 + 안정 selector 생성 |
| DOM 스냅샷 | CDP `DOMSnapshot.captureSnapshot` (paintOrder + DOMRects) |
| Accessibility tree | CDP `Accessibility.getFullAXTree` |
| 인증 상태 | `Storage.getCookies` + content script로 localStorage/sessionStorage/IndexedDB 덤프 |
| Code Coverage | CDP `Profiler.startPreciseCoverage` + `CSS.startRuleUsageTracking` |

---

## 4. 세션 / 이벤트 모델

수집된 모든 데이터는 시간순 이벤트 스트림으로 정규화한다.

```ts
type SessionEvent =
  | { type: 'navigation';   ts: number; url: string; frameId: string }
  | { type: 'click';        ts: number; selectors: SelectorSet; text?: string }
  | { type: 'input';        ts: number; selectors: SelectorSet; valueHash: string; redacted: boolean }
  | { type: 'request';      ts: number; reqId: string; method, url, headers, body, initiator }
  | { type: 'response';     ts: number; reqId: string; status, headers, bodyRef, fromServiceWorker: boolean }
  | { type: 'ws_frame';     ts: number; reqId: string; direction: 'send'|'recv'; payloadRef }
  | { type: 'screenshot';   ts: number; ref: string; viewportSize, devicePixelRatio }
  | { type: 'dom_snapshot'; ts: number; ref: string }
  | { type: 'console';      ts: number; level, args, stack }
  | { type: 'exception';    ts: number; message, stack, url, line }

type SelectorSet = {
  testId?: string       // data-testid
  role?: string         // ARIA role + name
  text?: string         // 가시 텍스트
  css?: string          // 최후수단
  xpath?: string
}
```

### 4.1 세션 메타데이터 (변동성 기록)

같은 URL이라도 결과가 달라지는 요인은 반드시 기록:

```ts
type SessionMeta = {
  startedAt: number
  userAgent: string
  viewport: { width: number; height: number }
  devicePixelRatio: number
  timezone: string
  locale: string
  storageState: StorageState   // 쿠키/localStorage/sessionStorage
  featureFlags?: Record<string, unknown>  // 식별 가능한 경우
  abTestVariants?: Record<string, string>
}
```

---

## 5. QA 재활용 파이프라인

수집과 가공을 분리한다.

```
[Raw Capture] → [Normalize] → [Generate] → [Verify]
```

1. **Raw Capture**: 위 이벤트 스트림 그대로 저장. 손실 없음.
2. **Normalize**: 노이즈 제거
   - analytics / 트래킹 요청 필터
   - 폴링성 반복 요청 그룹핑
   - mouseover/scroll 등 불필요한 인터랙션 제거
3. **Generate**:
   - 규칙 기반: 클릭+입력+네비게이션 시퀀스 → Playwright/Cypress 스크립트 템플릿
   - LLM 기반: 세션 요약, selector 안정화, Given/When/Then 변환
4. **Verify**: 생성된 테스트를 헤드리스로 재실행 → 원본과 diff
   - 스크린샷 diff (pixelmatch)
   - HAR diff (요청 시퀀스/상태코드)
   - 통과한 케이스만 신뢰 가능한 QA 자산으로 인정

---

## 6. 캡처 사각지대 (반드시 처리)

### 6.1 Shadow DOM / Web Components

- `outerHTML`은 closed shadow root를 잡지 못함
- CDP `DOM.getDocument({ pierce: true })` 또는 `DOMSnapshot.captureSnapshot` 사용
- 클릭 selector 생성시 `event.composedPath()` 기반으로 piercing path 기록

### 6.2 Canvas / WebGL / Video / Sandboxed iframe

- Canvas: `toDataURL()` 별도 캡처
- Video: 현재 frame 캡처
- Cross-origin iframe: content script 주입 실패 → frameId별 debugger attach 필요

### 6.3 사이트의 Service Worker 캐시

- `Network` 이벤트의 `fromServiceWorker: true` 플래그 확인
- 실제 origin 응답인지 캐시 응답인지 구분 안 하면 mock 생성시 함정

### 6.4 인증 / 세션 상태

- 쿠키 + localStorage + sessionStorage + IndexedDB 전체 스냅샷 없으면 재생 불가
- Playwright의 `storageState` 개념을 그대로 구현

### 6.5 WebSocket / SSE / GraphQL

- WS는 별도 CDP 이벤트 (`webSocketFrameSent/Received`)
- GraphQL은 응답 본문의 `operationName`으로 그루핑해야 분석 가능

### 6.6 타이밍 / Wait 조건

- 각 액션 직전 상태를 같이 기록:
  - 네트워크 idle 여부
  - 대상 element의 visibility / enabled 상태
  - 직전 DOM mutation 종료 여부
- 이게 없으면 재생시 flaky test가 됨

---

## 7. Selector 안정성 우선순위

생성된 테스트의 신뢰성을 좌우하는 핵심 요소.

```
1. data-testid / data-test       // 명시적
2. ARIA role + accessible name   // Accessibility tree 기반
3. 가시 텍스트                    // i18n에 약하지만 안정적
4. 구조적 selector (label > input 등)
5. CSS / XPath                   // 최후수단 (nth-child 회피)
```

각 액션 캡처시 위 모든 후보를 같이 저장하여 생성 단계에서 선택할 수 있게 함.

---

## 8. 보안 / 개인정보

### 8.1 자동 마스킹 규칙 (필수)

- `<input type="password">` 값
- 요청 헤더: `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`
- 패턴 매칭: 주민번호, 카드번호, 이메일 (옵션)
- 캡처 단계에서 즉시 해시/마스킹 → 원본 디스크 저장 금지

### 8.2 법적 고려 (한국 PIPA / GDPR)

- 캡처 시작 전 **명시적 동의 UI**
- 스크린샷의 OCR 가능 텍스트도 개인정보 위험 — 영역 블러 옵션
- 로컬 only vs 서버 전송 정책 명시
- 자동 만료 / 삭제 정책

### 8.3 Chrome Web Store 심사

`debugger`, `<all_urls>`, `webRequest` 권한을 함께 요청시 심사 매우 까다로움.

- 사용 사유 명확히 기술
- Privacy policy URL 필수
- 사내 사용이면 **Enterprise policy 강제 설치**가 현실적인 배포 경로

---

## 9. 운영 / 성능

### 9.1 MV3 Service Worker 수명

- 30초 idle이면 종료 → 세션 중단 위험
- 대응: `chrome.alarms` 주기 ping 또는 offscreen document로 long-running 작업 이동

### 9.2 데이터 크기 관리

- 스크린샷/HTML은 수백 MB 단위로 빠르게 누적
- IndexedDB origin 쿼터 (보통 디스크의 ~60%) 모니터링
- 압축: `CompressionStream` (gzip) 또는 lz-string
- 자동 청크 export (세션 분할 저장)

### 9.3 캡처 강도 조절

QoS 옵션화:
- **Lite**: URL + 사용자 액션 + 뷰포트 스크린샷
- **Standard**: + 네트워크 메타 + DOM 스냅샷
- **Forensic**: + 응답 본문 + 풀페이지 스크린샷 + coverage

---

## 10. MVP 단계 제안

도구를 단번에 만들지 말고 점진적으로:

| 단계 | 범위 | 산출물 |
|---|---|---|
| **M1** | 네트워크 + 뷰포트 스크린샷 | HAR viewer 수준 |
| **M2** | + 사용자 액션 레코딩 + storageState | Playwright codegen 대체 |
| **M3** | + DOM/AX snapshot + Coverage | 재구축용 자산 추출 |
| **M4** | + LLM 기반 테스트 생성 + Replay 검증 | full vision |

---

## 11. 디렉토리 구조 (제안)

```
unwrap/
├── extension/
│   ├── manifest.json
│   ├── background/        # service worker, debugger 제어
│   ├── content/           # DOM capture, event listener
│   ├── devtools/          # devtools panel
│   ├── sidepanel/         # 컨트롤 UI
│   └── shared/            # 이벤트 스키마, 유틸
├── processor/             # Normalize / Generate / Verify 파이프라인
│   ├── normalize/
│   ├── generate/          # Playwright/Cypress 변환
│   └── verify/            # replay + diff
├── viewer/                # 캡처 세션 뷰어 (웹앱)
└── DESIGN.md              # 본 문서
```

---

## 12. 미해결 / 추가 검토 필요

- [ ] iframe sandbox 정책별 캡처 가능 여부 매트릭스 작성
- [ ] OAuth 리다이렉트 흐름 캡처/재생 전략
- [ ] 파일 업로드/다운로드 처리
- [ ] PWA 설치 상태 캡처
- [ ] CSP report-only 모드 사이트에서의 동작
- [ ] 모바일 에뮬레이션 (touch event, devicePixelRatio)
- [ ] 다중 탭 / 팝업 윈도우 추적
- [ ] 시간 기반 동작 재현 (Date.now 고정)
