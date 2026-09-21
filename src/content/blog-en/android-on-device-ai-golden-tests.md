---
title: "Containing Non-Deterministic Output in On-Device AI Inference Testing"
lang: en
translationKey: android-on-device-ai-golden-tests
slug: android-on-device-ai-golden-tests
excerpt: "A practical guide to testing on-device AI inference with tolerance-based golden snapshots and P95 latency baselines."
publishDate: '2026-08-03'
tags:
- "Android"
- "AI"
- "Testing"
- "CI/CD"
seo:
  title: "On-Device AI Inference: Golden Files and P95 Baselines"
  description: "How to build CI guardrails for on-device AI inference using tolerance-based golden output comparisons and P95 latency baselines."
  pageType: article
---

Testing on-device AI inference has a thorny problem: **non-deterministic output**. Run the same model on the same input image, and the last few floating-point digits of the result can differ between two runs. GPU scheduling order, thread contention, and even phone temperature affect the final numeric values. The traditional software-testing iron law—same input always produces the same output—simply stops holding here.

I ran into this head-on while building CI regression tests for an image super-resolution model: tests that passed locally failed on CI machines, and every diff showed differences in the fourth decimal place. The approach I settled on was: if you cannot eliminate the non-determinism, contain it.

## Deterministic output verification: hash snapshots instead of exact comparison

Most inference non-determinism comes from differences in floating-point accumulation order when operators run in parallel. Dropout is already disabled during inference, and random initialization is long done, so this is the remaining variable. On a fixed device model and fixed framework version, accumulation-order differences are **controlled fluctuation**—they do not make the output “wrong,” only unstable in the last few digits.

The approach: run 50–100 representative inputs on a designated standard device, then compare each inference output tensor against the baseline tensor in the Golden File using **tolerance comparison**, rather than hashing the raw floating-point bytes directly. Hash functions such as MD5 are extremely sensitive to input: even a difference in the final floating-point digit produces a completely different hash, so they are fundamentally unable to express “tolerating small fluctuations.” What actually works is to define a numeric tolerance threshold first, then compare element by element:

```kotlin
/**
 * 逐元素比较两个张量，返回不一致的元素比例和最大绝对误差。
 * atol/rtol 参考 numpy.allclose 的容差定义：
 * |a - b| <= atol + rtol * |b| 时认为该元素一致。
 */
fun compareWithTolerance(
    actual: FloatArray,
    golden: FloatArray,
    atol: Float = 1e-4f,
    rtol: Float = 1e-3f
): ComparisonResult {
    require(actual.size == golden.size)
    var mismatchCount = 0
    var maxAbsError = 0f
    for (i in actual.indices) {
        val diff = abs(actual[i] - golden[i])
        maxAbsError = max(maxAbsError, diff)
        val threshold = atol + rtol * abs(golden[i])
        if (diff > threshold) mismatchCount++
    }
    return ComparisonResult(
        mismatchRatio = mismatchCount.toFloat() / actual.size,
        maxAbsError = maxAbsError
    )
}
```

If you really need a hash for snapshot archival—for example, to reduce Golden File size or make version comparisons easier—you must first **quantize/round** the floating-point values before hashing. Round each float to a fixed precision, say 3 decimal places, before it enters the hash calculation, so the hash can mask tail-end fluctuation that does not affect the result:

```kotlin
fun Tensor.toDeterministicHash(precision: Int = 3): String {
    val buffer = FloatArray(flatSize)
    this.readTo(buffer)
    // 先按固定精度舍入，抹平不影响结果的浮点尾部波动，再参与哈希
    val rounded = buffer.map { round(it * 10f.pow(precision)) / 10f.pow(precision) }
    val bytes = ByteBuffer.allocate(rounded.size * 4)
    rounded.forEach { bytes.putFloat(it) }
    return MessageDigest.getInstance("MD5")
        .digest(bytes.array())
        .joinToString("") { "%02x".format(it) }
}
```

Note that hashing after rounding is still an all-or-nothing verdict: if even one element still differs after rounding, the whole hash changes. What it tolerates is fluctuation “within rounding precision,” but it cannot tolerate the case where an individual element's error slightly exceeds that precision. In CI gatekeeping, therefore, the more reliable approach is to use the element-wise tolerance comparison above as the primary decision, with the hash only as a quick filter or archival aid.

The Golden File structure is simple:

```json
{
  "model": "super_res_v2.tflite",
  "delegate": "NNAPI",
  "device": "Pixel8",
  "snapshots": {
    "input_01": "a3f2c8d1...",
    "input_02": "7b1e9d0c..."
  }
}
```

New CI outputs are compared exhaustively with the Golden File using the element-wise tolerance comparison above. **The criterion combines two dimensions: whether the mismatch ratio exceeds a threshold, and whether the maximum absolute error exceeds a threshold.** These are two different things—the former measures how many elements fall outside tolerance, while the latter measures how far the out-of-tolerance elements deviate. Looking only at the ratio misses the case where a few elements have huge errors; looking only at error magnitude misses the case of broad, small drift. Both need to be bounded before the result can be considered stable. In practice, the mismatch ratio threshold is set at 2%, and the maximum absolute error threshold is set separately according to the numeric range of the specific task; a substantive change in inference behavior is declared only when either threshold is exceeded.

## Performance regression baseline: P95 is more useful than the average

Correct output does not mean performance has not regressed. Latency measurement for on-device inference is much messier than on the server side—mobile CPU frequency swings wildly, and a single sample is meaningless.

Perfetto is Android's platform-level tracing tool and can capture the end-to-end timeline from the application layer down to the hardware scheduler. Instrument the inference code:

```kotlin
class TfLiteInference(private val interpreter: Interpreter) {
    fun run(input: ByteBuffer, output: ByteBuffer) {
        Trace.beginSection("Inference_${modelName}")
        interpreter.run(input, output)
        Trace.endSection()
    }
}
```

In CI, use the perfetto command-line tool to collect traces from 30 inference runs, extract the per-run latency, and compute P50, P95, and P99. The performance baseline rule is: **a P95 increase of more than 15% is treated as a regression**.

Why P95 instead of the mean? The mean is dragged down by a small number of extremely fast samples and can hide problems, while P95 reflects the worst experience in most cases. Users are not particularly sensitive to an occasional single-frame stutter, but if tail latency is worsening across many frames, something is wrong with the inference pipeline.

## CI gate: combining the two baselines

Once the two baselines are ready, the CI decision flow is straightforward:

```bash
#!/bin/bash
# CI 推理质量门禁
RESULT=0

# 1. 输出容差验证
python inference_snapshot.py --input test_data/ --output snapshot.json
python diff_snapshot.py snapshot.json golden/golden.json --mismatch-ratio 0.02 --max-abs-error 0.01
if [ $? -ne 0 ]; then
    echo "❌ Output tolerance check exceeds threshold"
    RESULT=1
fi

# 2. 性能基线验证
python perfetto_bench.py --iterations 30 --baseline golden/perf_baseline.json
if [ $? -ne 0 ]; then
    echo "❌ P95 latency degradation detected"
    RESULT=1
fi

exit $RESULT
```

If both checks pass, CI goes green and the PR can be merged. If either one turns red, the merge is blocked.

## Three pitfalls I hit

**Pitfall 1: device warm-up.** On a cold CI device, the first few inference runs have noticeably higher latency, causing false positives in the performance baseline. The fix is to run 10 warm-up iterations before official collection; those samples are excluded from statistics.

**Pitfall 2: silent fallback in the NNAPI delegate.** When NNAPI does not support an operator, it silently falls back to CPU execution, and CPU inference can be 3–5× slower than GPU. In CI, explicitly check the delegate's actual operator coverage: a single-operator fallback emits a yellow warning; multiple fallbacks are treated as a red failure.

**Pitfall 3: golden files cannot be shared across devices.** Different chips have different floating-point implementations; Pixel 8 (Tensor G3) and Galaxy S24 (Snapdragon 8 Gen3) naturally produce different output hashes. In practice, maintain separate golden file directories keyed by chip model + Android version, and have CI match them automatically at runtime.

## Maintenance strategy

The ongoing cost of this system is concentrated in Golden File updates. Every model upgrade or inference-framework version change requires regenerating the hash baselines. I made this a separate CI Job—“Update Golden”—triggered manually only when needed, rather than running on every PR.

This approach differs from the traditional “exact output assertion” mindset: it does not pursue absolute determinism. Instead, it sets acceptable boundaries for the **fluctuation range** of on-device AI. Once that boundary is breached, either the inference behavior has genuinely changed and needs review, or the environment has changed and the baseline needs updating—both paths have clear follow-up actions.

Locking non-determinism into the cage of seeds, snapshots, and baselines is more pragmatic than chasing an impossible absolute precision.
