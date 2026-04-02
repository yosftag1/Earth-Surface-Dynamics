from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from data.normalise import normalize_tensor

HF_MODEL_ID = "BIFOLD-BigEarthNetv2-0/resnet50-s2-v0.2.0"


@dataclass
class LandCoverOutput:
    top_labels: list[dict[str, float | str]]
    probabilities: dict[str, float]


@dataclass
class ChangeOutput:
    change_score: float
    before_top_labels: list[dict[str, float | str]]
    after_top_labels: list[dict[str, float | str]]
    changed_classes: list[dict[str, float | str]]


class BigEarthNetInferenceService:
    """Load and run BigEarthNetv2.0 Hugging Face classifiers for backend inference.

    Important: This model performs scene-level multi-label classification, not pixel-level
    segmentation. For change detection APIs, compare class probabilities between two dates.
    """

    def __init__(self, model_id: str = HF_MODEL_ID, device: str | None = None) -> None:
        self.model_id = model_id
        self.device = torch.device(device or ("cuda" if torch.cuda.is_available() else "cpu"))
        self.model = self._load_model(model_id)
        self.labels = self._extract_labels(self.model)

    def _load_model(self, model_id: str) -> Any:
        # Prefer the official reBEN source code cloned into the repository.
        repo_root = Path(__file__).resolve().parents[1]
        local_reben_root = repo_root / "third_party" / "reben-training-scripts"
        if local_reben_root.exists() and str(local_reben_root) not in sys.path:
            sys.path.insert(0, str(local_reben_root))

        try:
            from reben_publication.BigEarthNetv2_0_ImageClassifier import (  # type: ignore[attr-defined]
                BigEarthNetv2_0_ImageClassifier,
            )
        except Exception as exc:
            raise RuntimeError(
                "Could not import reben_publication.BigEarthNetv2_0_ImageClassifier. "
                "Either clone the official reBEN repository to third_party/reben-training-scripts "
                "or install backend deps with Python 3.10/3.11:\n"
                "  pip install configilm>=0.4.10\n"
                "  pip install 'reben-publication @ git+https://git.tu-berlin.de/rsim/reben-training-scripts.git'\n"
                "Note: reben-publication currently does not support Python 3.12."
            ) from exc

        model = BigEarthNetv2_0_ImageClassifier.from_pretrained(model_id)
        model.to(self.device)
        model.eval()
        return model

    @staticmethod
    def _extract_labels(model: Any) -> list[str]:
        for attr in ("id2label", "labels", "class_names"):
            value = getattr(model, attr, None)
            if isinstance(value, dict):
                return [str(value[idx]) for idx in sorted(value.keys())]
            if isinstance(value, list):
                return [str(x) for x in value]

        config = getattr(model, "config", None)
        if config is not None:
            id2label = getattr(config, "id2label", None)
            if isinstance(id2label, dict):
                return [str(id2label[idx]) for idx in sorted(id2label.keys())]

        output_dim = 19
        classifier = getattr(model, "classifier", None)
        if classifier is not None and hasattr(classifier, "out_features"):
            output_dim = int(classifier.out_features)
        return [f"label_{idx}" for idx in range(output_dim)]

    def _prepare_image(self, image: np.ndarray | torch.Tensor) -> torch.Tensor:
        if isinstance(image, np.ndarray):
            image_tensor = torch.from_numpy(image).float()
        else:
            image_tensor = image.float()

        if image_tensor.ndim != 3:
            raise ValueError("Expected image tensor with shape [10, H, W] or [H, W, 10].")

        # Accept channel-last input and convert to channel-first.
        if image_tensor.shape[-1] == 10 and image_tensor.shape[0] != 10:
            image_tensor = image_tensor.permute(2, 0, 1)

        if image_tensor.shape[0] != 10:
            raise ValueError(f"Expected 10 Sentinel-2 channels, got {image_tensor.shape[0]}.")

        if image_tensor.shape[1:] != (224, 224):
            image_tensor = F.interpolate(
                image_tensor.unsqueeze(0),
                size=(224, 224),
                mode="bilinear",
                align_corners=False,
            ).squeeze(0)

        image_tensor = normalize_tensor(image_tensor)
        return image_tensor.unsqueeze(0).to(self.device)

    def _forward_probs(self, image: np.ndarray | torch.Tensor) -> torch.Tensor:
        x = self._prepare_image(image)
        with torch.no_grad():
            output = self.model(x)

        if hasattr(output, "logits"):
            logits = output.logits
        elif isinstance(output, dict) and "logits" in output:
            logits = output["logits"]
        elif torch.is_tensor(output):
            logits = output
        else:
            raise RuntimeError("Unexpected model output format; logits not found.")

        probs = torch.sigmoid(logits.squeeze(0)).detach().cpu()
        return probs

    def predict_land_cover(self, image: np.ndarray | torch.Tensor, top_k: int = 5) -> LandCoverOutput:
        probs = self._forward_probs(image)
        top_k = min(top_k, len(self.labels))
        top_vals, top_idx = torch.topk(probs, k=top_k)

        top_labels = [
            {"label": self.labels[int(idx)], "probability": float(val)}
            for val, idx in zip(top_vals.tolist(), top_idx.tolist())
        ]
        prob_map = {self.labels[idx]: float(probs[idx]) for idx in range(len(self.labels))}
        return LandCoverOutput(top_labels=top_labels, probabilities=prob_map)

    def predict_change(
        self,
        before_image: np.ndarray | torch.Tensor,
        after_image: np.ndarray | torch.Tensor,
        top_k: int = 5,
    ) -> ChangeOutput:
        before_probs = self._forward_probs(before_image)
        after_probs = self._forward_probs(after_image)

        # Scene-level change score based on class-probability shift.
        abs_delta = (after_probs - before_probs).abs()
        change_score = float(abs_delta.mean().item())

        before_top = self.predict_land_cover(before_image, top_k=top_k).top_labels
        after_top = self.predict_land_cover(after_image, top_k=top_k).top_labels

        changed_vals, changed_idx = torch.topk(abs_delta, k=min(top_k, len(self.labels)))
        changed_classes = [
            {
                "label": self.labels[int(idx)],
                "delta": float(delta),
                "before_probability": float(before_probs[int(idx)]),
                "after_probability": float(after_probs[int(idx)]),
            }
            for delta, idx in zip(changed_vals.tolist(), changed_idx.tolist())
        ]

        return ChangeOutput(
            change_score=change_score,
            before_top_labels=before_top,
            after_top_labels=after_top,
            changed_classes=changed_classes,
        )
