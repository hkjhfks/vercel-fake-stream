# Repository Guidelines

## Project Structure & Module Organization
- `api/` - Vercel Serverless Functions: `chat.js` (fake SSE stream proxy), `models.js` (list upstream models), `status.js` (health).
- `public/` - static test page: `index.html`.
- `vercel.json` - rewrites `/v1/chat/completions -> /api/chat` and `/v1/models -> /api/models`.
- `package.json` - scripts and deps; no build artifacts are checked in.

## Build, Test, and Development Commands
- `npm install` - install deps.
- `npm run dev` (or `npx vercel dev`) - run locally at `http://localhost:3000`.
- Quick checks:
  - Status: `curl http://localhost:3000/api/status`
  - Non-stream: `curl -sS -X POST http://localhost:3000/api/chat -H 'Content-Type: application/json' -H "Authorization: Bearer $OPENAI_API_KEY" -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":false}'`
  - Stream (SSE): same as above with `"stream":true`.

## Coding Style & Naming Conventions
- Node 18+, CommonJS (`require`/`module.exports`); 2-space indent; semicolons; single quotes.
- File names lower-case; use dashes for multi-word (e.g., `api/chat-stream.js`).
- Keep responses OpenAI/SSE compatible. Prefer using helpers in `api/chat.js` (`chunkText`, `formatSSEData`, heartbeat) and do not log secrets.
- Environment access via `process.env`; document any new vars in README.

## Testing Guidelines
- No unit test harness yet; validate via the test page (`/`) and `curl` commands above.
- If adding tests, prefer `vitest` or `jest`; place files under `api/__tests__/` and name `*.test.js`. Aim to cover SSE framing, error paths, and CORS headers.

## Commit & Pull Request Guidelines
- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`. Example: `feat(chat): add jitter to chunk delay`.
- PRs must include: what/why summary, linked issue (if any), local run steps, and screenshots/GIFs for the test page when UI changes.
- Keep changes small and focused; update `vercel.json` and README when routes/envs change.

## Security & Configuration Tips
- Never commit API keys. Required: `OPENAI_API_KEY`; optional: `SOURCE_API_URL`, `CORS_ALLOW_ORIGIN`, `ALLOW_ENV_API_KEY`, `HEARTBEAT_INTERVAL_MS`, `CHUNK_TARGET_LENGTH`, `CHUNK_DELAY_MS`, `UPSTREAM_EXTRA_HEADERS_JSON`, `DEBUG`.
- Use `DEBUG=1` only for local debugging; avoid sensitive logs.
