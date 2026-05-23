# Unwrap

서비스 분석용 Chrome Extension. 한 탭의 사용 흐름을 **세션 단위**로 기록해서 QA 테스트 생성 / 사이트 재구축의 원본 자산을 만든다.

전체 설계는 [DESIGN.md](./DESIGN.md) 참고. 이 문서는 **M1 + M2 + M3 (재구축 자산 추출까지)** 사용법.

## 기능 범위 (M1 + M2 + M3)

**M1 — 패시브 캡처**

- 네비게이션 / SPA URL 변경 캡처
- HTTP 요청·응답 메타 + 응답 본문 (CDP `Network.*` 사용)
- 인증 상태(localStorage / sessionStorage / cookies) 수동 캡처
- 세션 목록, 삭제, **HAR / JSON 내보내기**
- 민감 헤더(Authorization/Cookie 등) 자동 마스킹

**M2 — 액션 레코딩 + Playwright codegen**

- 사용자 인터랙션 캡처: `click`, `input` (debounced), `change`, `submit`, 네비게이션 키 (`Enter`/`Tab`/`Escape`/화살표 등)
- 안정 selector 생성 (우선순위: `data-testid` → ARIA role+name → label/placeholder → visible text → CSS)
- Shadow DOM 대응: `composedPath()` 기반 piercing path 같이 기록
- 민감 input 자동 마스킹 (`type=password`, `autocomplete=cc-*/new-password/otp`, name/aria-label 패턴 매칭)
- storageState **자동 캡처**: 세션 시작 + 메인 프레임 네비게이션 직후
- **Playwright spec.ts 내보내기**: `page.getByTestId/getByRole/getByLabel/...` + `storageState` 적용

**M3 — 재구축 자산 추출**

- **풀페이지 스크린샷** — CDP `Page.captureScreenshot { captureBeyondViewport: true }` (네비게이션 트리거)
- **DOM snapshot** — CDP `DOMSnapshot.captureSnapshot` (paint order + DOMRects 포함, 네비게이션 후 1.5s 지연)
- **Accessibility Tree** — CDP `Accessibility.getFullAXTree` (네비게이션 후, role/name 기반 분석 자산)
- **콘솔 + 예외** — `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` (call site + stack trace)
- **WebSocket 프레임** — `Network.webSocketCreated / FrameSent / FrameReceived / Closed`
- **Code Coverage** — `Profiler.startPreciseCoverage` + `CSS.startRuleUsageTracking` (세션 시작~종료 누적, JS+CSS used/total bytes 메타데이터로 노출)
- DOM/AX/Coverage 산출물은 IndexedDB blob으로 저장 → JSON export에 `blobIndex`로 포함

이후 M4(LLM 테스트 생성 + replay 검증)로 확장.

## 빌드

```bash
npm install
npm run build
```

빌드 산출물은 `dist/`.

## Chrome에 설치

1. Chrome → `chrome://extensions`
2. 우상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** → `dist/` 폴더 선택
4. 툴바 아이콘 클릭 → 사이드 패널 오픈

## 사용

1. 분석할 탭을 활성화
2. 사이드 패널 → **● Start recording**
   - 해당 탭에 `chrome.debugger`가 attach 되고 "DevTools가 이 탭을 디버깅 중입니다" 배너가 노출됨 (정상)
   - storageState (쿠키 + localStorage + sessionStorage)가 자동 캡처됨
3. 사이트를 평소처럼 사용 (클릭, 폼 입력, 페이지 이동)
   - 모든 인터랙션이 안정 selector와 함께 기록됨
   - 페이지 이동마다 storageState 재캡처
4. 끝나면 **■ Stop recording**
5. 내보내기 선택:
   - **Export Playwright** — 그대로 `npx playwright test`로 실행 가능한 `*.spec.ts`
   - **Export HAR** — 네트워크 분석/DevTools 호환
   - **Export JSON** — raw 캡처 + 메타데이터

## 개발

```bash
npm run dev        # Vite + @crxjs HMR
npm run typecheck
```

`npm run dev` 후 `dist/`를 unpacked로 설치하면 코드 변경 시 자동 재로드된다 (background는 수동 reload 필요할 수 있음).

## 알려진 제약

- `chrome.debugger` attach 배너는 우회 불가 (Chrome 정책).
- 응답 본문은 5MB 이상 / image·video·audio·font 는 저장 생략 (`src/shared/redact.ts:shouldCaptureResponseBody`).
- WebSocket 페이로드는 프레임당 64KB로 잘림 (`MAX_WS_PAYLOAD_LEN`); 콘솔 인자는 4KB로 잘림.
- DOM snapshot + AX tree + JS coverage는 페이지당 수 MB까지 커질 수 있음 — 긴 세션은 IndexedDB 쿼터(보통 디스크의 ~60%) 모니터링 필요.
- DOM snapshot은 메인 프레임 네비게이션 후 1.5s 지연으로 한 번씩 캡처 (네비게이션이 빠른 SPA에서 일부 상태 누락 가능).
- **Shadow DOM**: open shadow root는 `composedPath()`로 piercing path를 같이 기록. closed shadow는 향후 CDP `DOM.pierce`로 보강 예정.
- **Playwright export**: 민감 입력은 `'REPLACE_ME'` 자리표시자 + `[REDACTED]` 주석으로 남음 — 실행 전 환경변수/픽스처로 치환 필요.

## 디렉토리

```
src/
├── background/
│   ├── index.ts          message router, session lifecycle
│   ├── recorder.ts       debugger orchestrator: network, console, exception, ws, screenshots, nav hooks
│   ├── snapshot.ts       DOMSnapshot + AX tree capture
│   ├── coverage.ts       JS/CSS precise coverage
│   ├── storage-state.ts  cookies + localStorage + sessionStorage snapshot
│   ├── export.ts         HAR + JSON + Playwright spec.ts emitters
│   └── playwright.ts     session → Playwright codegen
├── content/
│   ├── index.ts          bootstrap (asks "am I recording?")
│   ├── recorder.ts       click / input / change / submit / keydown listeners
│   └── selector.ts       stable selector ladder + shadow DOM piercing
├── sidepanel/             React UI (start/stop, session list, exports)
├── shared/                event schema, IndexedDB, header redaction
└── manifest.config.ts     MV3 manifest
```
