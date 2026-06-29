#!/usr/bin/env python3
"""Run a tiny MLX gradient-descent smoke test on Apple Silicon."""

from __future__ import annotations

import json

import mlx.core as mx


def main() -> None:
    xs = mx.array([1.0, 2.0, 3.0, 4.0])
    ys = xs * 2.0
    weight = mx.array(0.0)

    def loss(value: mx.array) -> mx.array:
        return mx.mean((value * xs - ys) ** 2)

    gradient = mx.grad(loss)
    loss_start = loss(weight)

    for _ in range(50):
        weight = weight - 0.05 * gradient(weight)

    loss_end = loss(weight)
    mx.eval(weight, loss_start, loss_end)

    device = str(mx.default_device())
    result = {
        "backend": "mlx",
        "device": device,
        "weight": float(weight),
        "loss_start": float(loss_start),
        "loss_end": float(loss_end),
        "loss_delta": float(loss_start - loss_end),
    }

    if "gpu" not in device:
        raise RuntimeError(f"expected MLX GPU device, got {device}")
    if result["loss_end"] >= result["loss_start"]:
        raise RuntimeError("MLX smoke training did not reduce loss")
    if abs(result["weight"] - 2.0) > 0.001:
        raise RuntimeError(f"unexpected trained weight: {result['weight']}")

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
