# Laya AI POC — workspace instructions

- Keep the React + TypeScript + Vite frontend and the local Python FastAPI service that calls the official `laya` package.
- Use Laya for bounded typed decisions (`choice`, `score`, `noul`); do not present it as a chat/text generation model.
- The frontend must never use simulated model predictions; show local API/model errors clearly.
- Keep inference local by default; do not add hosted services, API keys, persistence, or uploads without an explicit request.
- Preserve responsive behavior, accessible labels, and visible focus states.
- Validate frontend changes with `npm run build` and `npm run lint`; validate Python changes with `python -m compileall backend`.
