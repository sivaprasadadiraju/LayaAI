"""Small local API that exposes the official Laya Router to the Vite POC."""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Laya AI POC API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

router: Any | None = None


class PredictRequest(BaseModel):
    state: dict[str, Any]
    questions: dict[str, dict[str, Any]]
    model: str | None = None


class EvalExample(BaseModel):
    text: str = Field(min_length=1, max_length=12000)
    expected: str


class EvaluateRequest(BaseModel):
    examples: list[EvalExample] = Field(min_length=1, max_length=64)
    criteria: dict[str, str] = Field(min_length=2, max_length=20)
    instructions: str = Field(min_length=1, max_length=500)
    threshold: float = Field(default=0.7, ge=0.0, le=1.0)
    model: str | None = None


def get_router() -> Any:
    """Create the model router only when the first inference request arrives."""
    global router
    if router is None:
        try:
            from laya import Router
        except ImportError as exc:
            raise HTTPException(
                status_code=503,
                detail="Laya is not installed in this Python environment. Follow the backend setup steps in README.md.",
            ) from exc
        device = os.getenv("LAYA_DEVICE")
        router = Router(device=device) if device else Router()
    return router


def json_safe(value: Any) -> Any:
    """Convert common tensor/scalar values into JSON-serializable Python values."""
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if hasattr(value, "tolist"):
        return json_safe(value.tolist())
    if hasattr(value, "item"):
        return json_safe(value.item())
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def run_prediction(state: dict[str, Any], questions: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    try:
        active_router = get_router()
        result = active_router.predict(state, questions, **({"model": model} if model else {}))
        return json_safe(result)
    except HTTPException:
        raise
    except Exception as exc:  # surface model download / validation errors to the UI
        raise HTTPException(status_code=502, detail=f"Laya prediction failed: {exc}") from exc


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "model_loaded": router is not None, "device": os.getenv("LAYA_DEVICE", "auto")}


@app.post("/api/predict")
def predict(request: PredictRequest) -> dict[str, Any]:
    return run_prediction(request.state, request.questions, request.model)


@app.post("/api/evaluate")
def evaluate(request: EvaluateRequest) -> dict[str, Any]:
    unknown = sorted({example.expected for example in request.examples} - set(request.criteria))
    if unknown:
        raise HTTPException(status_code=422, detail=f"Expected labels missing from criteria: {', '.join(unknown)}")

    questions = {
        "decision": {
            "type": "choice",
            "instructions": request.instructions,
            "criteria": request.criteria,
        }
    }
    requests = [
        {
            "state": {"text": example.text},
            "questions": questions,
            **({"model": request.model} if request.model else {}),
        }
        for example in request.examples
    ]

    try:
        results = get_router().predict_batch(requests)
    except Exception as exc:
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=502, detail=f"Laya evaluation failed: {exc}") from exc

    rows: list[dict[str, Any]] = []
    confusion = {label: {target: 0 for target in request.criteria} for label in request.criteria}
    correct = 0
    automated_correct = 0
    automated = 0
    for example, raw_result in zip(request.examples, results, strict=True):
        result = json_safe(raw_result)
        answer = result.get("answers", {}).get("decision", {})
        prediction = answer.get("choice")
        confidence = answer.get("answer_confidence", answer.get("confidence", 0.0))
        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            confidence = 0.0
        is_correct = prediction == example.expected
        correct += int(is_correct)
        if prediction in confusion and example.expected in confusion[prediction]:
            confusion[example.expected][prediction] += 1
        is_automated = confidence >= request.threshold
        automated += int(is_automated)
        automated_correct += int(is_automated and is_correct)
        rows.append({
            "text": example.text,
            "expected": example.expected,
            "prediction": prediction,
            "confidence": confidence,
            "correct": is_correct,
            "automated": is_automated,
        })

    count = len(rows)
    ece = 0.0
    for bin_index in range(10):
        lower = bin_index / 10
        upper = (bin_index + 1) / 10
        members = [
            row for row in rows
            if lower <= row["confidence"] < upper
            or (bin_index == 9 and row["confidence"] == 1.0)
        ]
        if members:
            mean_confidence = sum(row["confidence"] for row in members) / len(members)
            mean_accuracy = sum(int(row["correct"]) for row in members) / len(members)
            ece += len(members) / count * abs(mean_accuracy - mean_confidence)

    return {
        "count": count,
        "accuracy": correct / count,
        "ece": ece,
        "coverage": automated / count,
        "selective_accuracy": automated_correct / automated if automated else None,
        "threshold": request.threshold,
        "confusion_matrix": confusion,
        "rows": rows,
    }
