
# Micron Force — In‑House ChatGPT (Superadmin + User)

This bundle gives you a complete **in‑house** ChatGPT integration:
- **Superadmin page**: full control (model/voice/system prompt), logs, TTS/STT.
- **User page**: production chat widget (text + optional voice).
- **Server**: Node + Express + SQLite (no 3rd party hosting).

## Quick start

1) **Server**
```bash
cd server
npm i
cp .env.example .env   # put your OPENAI_API_KEY; adjust PORT if needed
npm start              # runs on http://localhost:8080
```
> Use NGINX/Apache to reverse proxy `https://api.yourdomain.com` → `localhost:8080`.

2) **Wire your pages**
- Superadmin: open your existing `micronforce_superadmin.html` and paste the **container + script** from `web/micronforce_superadmin.html` (or just use this file as your superadmin page).
- User: embed the **chat snippet** from `web/micronforce_user_chat_snippet.html` inside your user page. If you want a quick test page, `web/micronforce_user_chat_standalone.html` is a drop‑in.

3) **Configure the API base URL**
- In the `<script>` blocks, set `const API = 'https://api.yourdomain.com'` (or empty string `''` when serving from the same origin).

4) **Production notes**
- Replace the `requireSuperadmin` and `requireUser` middlewares with your real **JWT verification** (set role claims).
- Remove the temporary `x-admin` bypass header in production.
- Keep `OPENAI_API_KEY` **server‑side only**.
- Consider adding HTTPS, WAF, and a persistent volume for `micronforce_gpt.sqlite`.

## Endpoints

- **Superadmin only**
  - `GET /api/super/settings` / `PUT /api/super/settings`
  - `POST /api/super/chat` (text chat)
  - `GET /api/super/tts?text=...&voice=...` (audio/mpeg)
  - `POST /api/super/stt` (Whisper; multipart with `audio` file)
  - `GET /api/super/logs?q=&limit=`

- **User**
  - `POST /api/chat/user/send` (text chat; optional TTS on client via `/api/tts`)
  - `GET /api/tts?text=...&voice=...` (audio/mpeg)
  - `POST /api/stt` (Whisper; multipart with `audio`)

## Rate limits
Basic in‑memory per‑IP limiter is included. Adjust limits in `index.js` as needed.

## Licensing
This bundle is provided as-is; you are responsible for your OpenAI usage and compliance.
