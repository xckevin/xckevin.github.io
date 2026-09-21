---
title: 'Android Transformer Optimization: Attention and Mobile GPU Bottlenecks'
lang: en
translationKey: android-transformer-flashattention-mobile-gpu
slug: android-transformer-flashattention-mobile-gpu
excerpt: A walkthrough of porting FlashAttention into an OpenGL ES Compute Shader on Android, using tiled computation and Online Softmax to cut attention memory traffic from O(n²) to O(n). Measured on the Mali-G710, latency dropped from 120ms to 18ms.
publishDate: '2026-09-19'
tags:
- Android
- Performance Optimization
- GPU
- FlashAttention
- Transformer
seo:
  title: 'Android On-Device AI: FlashAttention in Mobile GPU Compute Shaders'
  description: 'FlashAttention in OpenGL ES compute shaders on Android: tiling and Online Softmax cut attention traffic from O(n²) to O(n), plus fp16 and bank-conflict fixes.'
  pageType: article
---

When running a 1B-parameter LLM on device, the prefill latency always gets stuck in the attention operator. Profiling with the Mali Offline Compiler and the system profiler revealed that the bottleneck is not GEMM compute throughput, but reading and writing intermediate tensors. This post documents how I moved FlashAttention into an OpenGL ES Compute Shader.

## The Self-Attention Bottleneck Is Memory Traffic, Not Compute

The standard attention flow is `S = QK^T`, `P = softmax(S)`, `O = PV`.

When the sequence length is n, the intermediate matrix S is n×n. At n=2048 with fp16, S occupies 8MB. This matrix is first written back to global memory, then read out again for softmax, then read out again to multiply by V — three full passes of reads and writes.

Mobile GPU LPDDR bandwidth is an order of magnitude lower than that of desktop graphics cards, which further amplifies this problem. On the Mali-G710, I measured the attention operator's arithmetic intensity at roughly 1/20 of GEMM's, so the compute units spend most of their time waiting for data.

## The Essence of FlashAttention: Reordering the Computation

FlashAttention does not change the mathematical result; it only changes the order of computation. The core idea comes down to two points:

1. Slice Q, K, and V into small blocks, compute attention for only one small tile at a time, and never materialize the full S matrix.
2. Use Online Softmax to incrementally maintain the running maximum and the denominator, then normalize once at the end.

Tiling introduces a numerical stability concern: softmax subtracts the maximum to prevent exponential overflow, but when processing block by block, a new block may have a larger maximum, so previously accumulated results must be scaled back proportionally.

```python
# Online Softmax 分块更新
m_new = max(m_old, max(S_block))           # 更新 running max
scale = exp(m_old - m_new)                 # 旧累计的缩放因子
l_new = l_old * scale + sum(exp(S_block - m_new))
O_new = O_old * scale + P_block @ V_block  # 加权累加输出
```

This way each tile enters and leaves memory only once, and global memory traffic drops from O(n²) to O(n).

## Mobile GPU Constraints: How to Implement It in a Compute Shader

For the on-device implementation, I chose the Compute Shader from OpenGL ES 3.1 rather than Vulkan. The reasoning is straightforward: it has broader coverage on older devices, and the GPU backend of NNAPI takes the same technical route, so it can be reused later.

Two differences between mobile and desktop GPUs directly affect the implementation:

- There is no high-bandwidth L2, and shared memory is very small. On Mali, workgroup memory is usually on the order of 16KB, so the tile size must be set right against that limit.
- Workgroup dispatch overhead is high, so a single workgroup should compute one complete output tile in one go, iterating over all K-direction blocks in an inner loop.

The shared memory declaration in GLSL:

```glsl
// 每个 workgroup 缓存一个 K 方向 tile
shared mediump float Qs[BR][BD];
shared mediump float Ks[BC][BD];
```

`mediump float` only guarantees 10 bits of precision in the GLSL ES specification. To actually store fp16 in shared memory, you need extension support; many devices do not support it and directly fall back to fp32, doubling bandwidth. That's where I hit a snag later.

## A Complete Tile Loop

The core loop structure: the outer loop iterates over row blocks of Q, and the inner loop iterates over column blocks of K/V.

```glsl
for (int j = 0; j < TC; j++) {         // 遍历 K/V 列块
    load_tile(Ks, K, j);               // 协作加载 K tile
    float S[BR][BC];
    matmul(S, Qs, Ks);                 // S = Qs @ Ks^T
    float m_new = max(m_old, row_max(S));
    float scale = exp(m_old - m_new);
    l = l * scale + row_sum(exp(S - m_new));
    load_tile(Vs, V, j);
    O = O * scale + exp(S - m_new) * Vs;   // 累加输出
    m_old = m_new;
}
```

S stays in registers the entire time and is never written back to global memory — that's the key to saving bandwidth. At the end of the workgroup, `l` is used to normalize and output O once.

## Pitfalls I Hit

**fp16 precision**: Storing fp16 in shared memory on Mali requires `GL_EXT_shader_16bit_storage`; quite a few mid-range chips don't support it, so you can only fall back to fp32, and the tile size gets cut in half. My approach is to generate two variants at compile time and probe the extension at runtime to choose the path.

**Bank conflicts**: Using `mat4` vectorized loads for the K tile reduces the instruction count, but a wrong shared memory layout introduces bank conflicts. Make adjacent threads access adjacent banks, and think carefully about whether the tile is stored in row-major or column-major order. After switching to column-major, conflicts dropped noticeably.

**Numerical stability**: `scale = exp(m_old - m_new)` underflows to 0 when the gap is large, which is mathematically correct, but some GPUs produce abnormal values when fast-math is enabled, so you need to turn off the precision hint.

Measured on the Mali-G710, attention for a 2048 sequence dropped from 120ms to 18ms — more than a 6× improvement.

## Implementation Recommendations

When choosing the tile size, first check the target device's workgroup memory limit, then reserve space for the Q, K, and V tiles plus the output buffer — don't just pick a number off the top of your head.

Generate both fp16 and fp32 variants at compile time and select the path by probing the extension at runtime; this is less hassle than dynamically branching with `#ifdef` inside the shader.

In terms of optimization order, first fix memory traffic, then tune bank conflicts, and only touch precision hints last. In GPU optimization, 80% of the gains come from the first two steps; precision-related fine-tuning often isn't worth the trouble.
