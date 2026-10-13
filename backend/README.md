# ÜrünümX AI Backend

Node.js/Express REST endpoint that protects API keys on the server and connects Tavily Search to Gemini.

## Local development

1. Use Node.js 22 or another supported Node 20+ release.
2. Run `npm install` in this directory.
3. Copy `.env.example` to `.env` and enter your keys. Never commit `.env`.
4. Run `npm start`.
5. `GET http://localhost:10000/health` should show `configured: true`.

## POST `/api/research`

Example body:

```json
{"mode":"research","query":"Samsung Galaxy S24 FE teknik özellikler"}
```

Modes: `research`, `prices`, `compare`. Compare body example:

```json
{"mode":"compare","query":"Samsung Galaxy S24 FE","productA":"Samsung Galaxy S24 FE","productB":"Samsung Galaxy A56"}
```

The client requires HTTPS in its saved backend URL. For production, add user authentication and server-side account-based quota tracking before launching paid plans. The included IP limiter is a basic MVP guard, not a replacement for authentication.
