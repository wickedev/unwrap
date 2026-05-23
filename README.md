# Unwrap

기존 웹 서비스를 분석해 **QA 테스트 케이스를 생성**하거나 **재구축**하기 위한 도구. Chrome 확장이 한 탭의 사용 흐름을 세션 단위로 캡처하고, Cloudflare Workers 위에서 동작하는 백엔드가 Gemini로 더 풍부한 Playwright spec을 생성한다.

설계 배경: [DESIGN.md](./DESIGN.md).

## 모노레포 구성 (pnpm)

```
unwrap/
├── apps/
│   ├── extension/        Chrome MV3 확장 (TypeScript + React 18 + Vite + @crxjs)
│   └── server/           Cloudflare Workers 백엔드 (Hono + Google OAuth + Gemini)
└── packages/
    └── protocol/         확장 ↔ 서버 와이어 타입
```

## 기능 (M1 + M2 + M3 + M4)

- **M1** 패시브 캡처 — `chrome.debugger` + CDP로 네트워크/네비게이션/응답 본문/스크린샷
- **M2** 액션 레코딩 — 클릭/입력/체인지/서밋/네비키, 안정 selector (testid → role+name → label → text → CSS), Shadow DOM `composedPath`, 민감 입력 자동 마스킹, 자동 storageState
- **M2** 규칙 기반 Playwright export — `page.getByRole/getByTestId/...` + storageState 인라인
- **M3** 재구축 자산 — 풀페이지 스크린샷, DOMSnapshot, AX tree, 콘솔/예외, WebSocket 프레임, JS/CSS code coverage
- **M4** **AI 기반 Playwright 생성** — 세션 요약 + 핵심 스크린샷을 Cloudflare Workers 백엔드로 보내면 Gemini가 어설션이 보강된 spec을 돌려준다. 인증은 서버를 거치는 Google OAuth, 짧은 JWT를 `chrome.storage.local`에 저장.

## 빠른 시작

전제: Node 22+, pnpm 10+, `wrangler` (서버 배포 시).

```bash
pnpm install
pnpm build           # 모든 워크스페이스 빌드
```

### 확장 설치

```bash
pnpm build:extension
```

1. Chrome → `chrome://extensions`
2. **개발자 모드** ON
3. **압축해제된 확장 프로그램을 로드합니다** → `apps/extension/dist/` 선택
4. 툴바 아이콘 → 사이드 패널 열림

### 서버 (로컬 / Cloudflare Workers)

1. **Google Cloud Console**에서 OAuth 2.0 클라이언트(Web application) 생성. Authorized redirect URI: `https://<your-worker-subdomain>.workers.dev/auth/google/callback` (로컬은 `http://localhost:8787/auth/google/callback`).
2. **Gemini API key**를 [Google AI Studio](https://aistudio.google.com/apikey)에서 발급.
3. KV 네임스페이스 생성 후 `apps/server/wrangler.toml`의 `OAUTH_STATE` 바인딩에 ID 입력:
   ```bash
   pnpm --filter @unwrap/server exec wrangler kv namespace create OAUTH_STATE
   ```
4. 시크릿 등록:
   ```bash
   cd apps/server
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put GEMINI_API_KEY
   wrangler secret put JWT_SECRET   # 임의의 32바이트 이상 문자열
   ```
   로컬 개발은 `apps/server/.dev.vars` (gitignored)에 같은 값들을 평문으로 넣으면 됩니다.
5. (선택) `wrangler.toml`의 `ALLOWED_EMAILS`에 `you@example.com,@company.com` 식으로 화이트리스트 설정.
6. 로컬:
   ```bash
   pnpm dev:server   # http://localhost:8787
   ```
   배포:
   ```bash
   pnpm deploy:server
   ```

### 확장에서 서버 연결

1. 사이드 패널 → ⚙ Settings
2. **Server URL**에 워커 URL 입력 (예: `https://unwrap-server.your-domain.workers.dev`)
3. **Sign in with Google** 클릭 → 새 탭에서 Google 인증 → 자동으로 확장으로 돌아옴
4. 세션 카드의 **✨ Generate AI test** 버튼 활성화

## 사용

1. 분석할 탭 활성화
2. 사이드 패널 → **● Start recording**
   - `chrome.debugger`가 attach되고 "DevTools가 이 탭을 디버깅 중입니다" 배너가 노출됨 (정상)
   - storageState 자동 캡처
3. 사이트를 평소처럼 사용 (클릭, 폼 입력, 페이지 이동)
4. **■ Stop recording**
5. 내보내기:
   - **✨ Generate AI test** — Gemini가 보강한 `*.ai.spec.ts` (어설션 + Given/When/Then 코멘트 포함)
   - **Export Playwright** — 규칙 기반 `*.spec.ts`
   - **Export HAR** — DevTools 호환 네트워크 로그
   - **Export JSON** — raw 캡처 + 메타데이터

## 알려진 제약

- `chrome.debugger` attach 배너는 우회 불가 (Chrome 정책).
- 응답 본문 5MB 이상 / image·video·audio·font 는 저장 생략. WebSocket 페이로드는 프레임당 64KB로 truncate.
- DOM snapshot은 메인 프레임 네비게이션 후 1.5s 지연으로 한 번 캡처.
- AI 생성 시 서버에 전송되는 데이터: 액션 시퀀스, 안전한 selector 후보, storage state **키 이름만** (값은 미전송), 첫/마지막 스크린샷 (long-edge 1024px로 다운샘플링). 민감 입력 값은 사전에 마스킹됨.
- Gemini 모델 기본값은 `gemini-2.5-pro` (`wrangler.toml`의 `GEMINI_MODEL`에서 변경).
- closed Shadow DOM 분석은 아직 미구현 (open shadow는 `composedPath` piercing 처리).

## 디렉토리

```
apps/extension/src/
├── manifest.config.ts
├── background/
│   ├── index.ts          message router, session lifecycle
│   ├── recorder.ts       debugger orchestrator: network/console/exception/ws/shots/nav
│   ├── snapshot.ts       DOMSnapshot + AX tree
│   ├── coverage.ts       JS/CSS precise coverage
│   ├── storage-state.ts  cookies + localStorage + sessionStorage
│   ├── auth.ts           Google OAuth via launchWebAuthFlow + JWT
│   ├── summarize.ts      events → SessionSummary (server에 전송할 데이터)
│   ├── screenshots.ts    LLM용 스크린샷 픽 + 다운샘플링
│   ├── llm.ts            서버 /api/generate 호출
│   ├── export.ts         HAR + JSON + Playwright spec.ts
│   └── playwright.ts     세션 → Playwright codegen
├── content/              click/input/change/submit/keydown + 안정 selector
├── sidepanel/            React UI (start/stop, sessions, settings, AI generate)
└── shared/               event schema, IndexedDB, redaction, settings

apps/server/src/
├── index.ts              Hono 라우터
├── auth/
│   ├── google.ts         OAuth 2.0 flow + email allowlist
│   └── jwt.ts            sign / verify
├── gemini.ts             generativelanguage.googleapis.com 호출 + 응답 파싱
└── env.ts                CF Workers 바인딩 타입

packages/protocol/src/
└── index.ts              SessionSummary / GenerateRequest / GenerateResponse / Auth*
```

## 개발

```bash
pnpm dev:extension       # Vite + @crxjs HMR
pnpm dev:server          # wrangler dev
pnpm typecheck           # 전체 워크스페이스
pnpm build               # 전체 워크스페이스
```
