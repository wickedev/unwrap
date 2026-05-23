# @unwrap/server

Cloudflare Workers 백엔드. Chrome 확장 (`@unwrap/extension`)으로부터 세션 요약을 받아 **Google OAuth로 인증**된 사용자에 한해 **Gemini**로 보강된 Playwright spec을 생성해 돌려준다.

## 엔드포인트

| Method | Path | 인증 | 설명 |
|---|---|---|---|
| GET  | `/health` | - | 헬스체크 |
| POST | `/auth/google/start` | - | OAuth flow 시작. body: `{ extensionRedirect }`. response: `{ authUrl, state }` |
| GET  | `/auth/google/callback` | - | Google이 호출하는 콜백. JWT를 발급해 `extensionRedirect`로 302 |
| GET  | `/api/me` | Bearer JWT | 현재 사용자 |
| POST | `/api/generate` | Bearer JWT | session summary + screenshots → 보강된 Playwright spec |

## 시크릿 / 변수

| 종류 | 이름 | 설명 |
|---|---|---|
| Secret | `GOOGLE_CLIENT_ID` | Google OAuth 클라이언트 ID (Web app) |
| Secret | `GOOGLE_CLIENT_SECRET` | Google OAuth 클라이언트 시크릿 |
| Secret | `GEMINI_API_KEY` | Google AI Studio에서 발급한 API 키 |
| Secret | `JWT_SECRET` | 임의의 32바이트 이상 문자열 (HMAC HS256) |
| Var | `ALLOWED_EMAILS` | 콤마 구분. `you@example.com,@company.com` 식. 비우면 모든 Google 계정 허용 |
| Var | `GEMINI_MODEL` | 기본 `gemini-2.5-pro` |
| Var | `EXTENSION_REDIRECT_URL` | (선택 — start에서 검증용으로 사용 가능) |
| KV | `OAUTH_STATE` | OAuth state 임시 보관 (TTL 10분) |

## 셋업

```bash
# 1. KV 생성
wrangler kv namespace create OAUTH_STATE
# → wrangler.toml의 OAUTH_STATE id에 붙여넣기

# 2. 시크릿 등록 (production)
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GEMINI_API_KEY
wrangler secret put JWT_SECRET

# 3. 로컬 개발은 .dev.vars (gitignored)에 같은 값 평문 저장
cp .dev.vars.example .dev.vars
# 편집...

# 4. 로컬 실행
pnpm dev

# 5. 배포
pnpm deploy
```

## Google OAuth 클라이언트

Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID → **Web application**

- **Authorized redirect URIs**: production은 `https://<your-worker>.workers.dev/auth/google/callback`, 로컬은 `http://localhost:8787/auth/google/callback`. 둘 다 등록해두면 편함.

## 확장 ↔ 서버 흐름

```
extension                                  server
   │  1. POST /auth/google/start
   │     { extensionRedirect: chromiumapp.org URL }
   │  ────────────────────────────────────▶
   │                                       state → KV (TTL 10m)
   │                                       authUrl 생성
   │  ◀────────────────────────────────────
   │     { authUrl, state }
   │
   │  2. chrome.identity.launchWebAuthFlow(authUrl)
   │     → Google 로그인 → server callback
   │
   │                                       3. /auth/google/callback?code=...&state=...
   │                                          KV에서 state 검증 + 소거
   │                                          code → access_token → userinfo
   │                                          email allowlist 검증
   │                                          HS256 JWT 발급
   │                                          302 → extensionRedirect?token=...
   │  ◀────────────────────────────────────
   │
   │  4. token / email / expires_at → chrome.storage.local
   │
   │  5. POST /api/generate
   │     Authorization: Bearer <jwt>
   │     body: { summary, fallbackSpec, screenshots[<=2] }
   │  ────────────────────────────────────▶
   │                                       JWT verify
   │                                       Gemini 호출 (responseSchema로 구조화)
   │  ◀────────────────────────────────────
   │     { spec, description, assertions_added, warnings, model, usage }
```

## 비용 메모

- Gemini 2.5 Pro: 입력 토큰이 비싸므로 (스크린샷이 큰 비중) 화면당 1024px로 다운샘플링 후 전송. 일반적인 세션 1회당 수 cent 수준.
- Cloudflare Workers 무료 티어로 일평균 100k 요청까지 커버.
- KV 무료 티어로 OAuth state(TTL 10m)는 충분.
