# Laya AI decision-model POC

A local proof of concept for Convai Innovations' Laya model. Unlike a chatbot, Laya does not generate prose: it answers typed `choice`, `score`, and `noul` questions about an input state and returns structured decisions with probabilities. This app makes one real `Router.predict()` call for the triage questions and includes a small labeled-set evaluation workflow.

## Requirements

- Node.js supported by the Vite project
- Python 3.10 or newer (the current environment has Python 3.14)
- Internet access on the first model run to download checkpoint files from Hugging Face; enough disk space and RAM for the selected checkpoint and PyTorch runtime

## Windows setup

Open two PowerShell terminals in the project root.

### 1. Set up and start the Laya API

```powershell
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8001
```

If Python 3.14 is not installed on another machine, use an installed Python 3.10+ version in the `py` command. The model weights download the first time you click **Run decision** or **Run evaluation**; later runs use the Hugging Face cache. Leave this API terminal running.

### 2. Start the frontend

```powershell
npm.cmd install
npm.cmd run dev
```

Open the local address Vite prints (usually `http://localhost:5173`). `npm.cmd` avoids PowerShell's execution-policy error for `npm.ps1`.

## Try the POC

- **Decision studio:** use a sample support request or edit the JSON state, choose Auto/English/Multilingual/Typed-decisions, and run four typed questions in one prediction call: department (`choice`), urgency (`score`), cancellation risk (`noul`), and refund request (`noul`). Inspect distributions, confidence, routing metadata, and the raw response.
- **Evaluate quality:** run a small labeled support-ticket dataset. The report shows top-1 accuracy, ten-bin expected calibration error (ECE), coverage at the selected confidence threshold, accuracy on auto-routed examples, a confusion matrix, and per-example outcomes. Edit the sample JSON to test your own cases; expected labels must match one of the rubric labels.

The model selector uses the official router by default. Explicit choices map to the official `english`, `multilingual`, and `typed-decisions` checkpoint names.

## Local API

The FastAPI service in `backend/app.py` exposes `GET /api/health`, `POST /api/predict`, and `POST /api/evaluate`. Vite forwards `/api` requests to `127.0.0.1:8001`. The service creates Laya's `Router` lazily when the first inference request arrives. Set `LAYA_DEVICE=cpu` before starting Uvicorn to pin CPU inference, or use a supported device value for your installation.

## Evaluation cautions

The bundled examples are only a smoke-test fixture, not a benchmark. ECE is a simple ten-bin estimate and is noisy on small datasets. Split examples by customer/conversation, keep a final test set untouched, include ambiguous and costly failure cases, and report per-class metrics and slices. Selective accuracy is measured only on cases whose `answer_confidence` clears the slider threshold; coverage is reported alongside it so abstention cannot hide the review workload. Model confidence is not a guarantee of correctness or calibration. Validate thresholds and each checkpoint on representative held-out data before connecting decisions to real actions. The `noul` questions use explicit criteria and neutral `A`/`B` model-facing labels because the upstream model card documents label sensitivity.

The app makes no hosted model calls and stores no conversations or evaluation data. First-time model downloads do require Hugging Face network access. Laya returns decisions, not customer-facing explanations or generated text.

## Checks

```powershell
npm.cmd run build
npm.cmd run lint
.\.venv\Scripts\python.exe -m compileall backend
```
