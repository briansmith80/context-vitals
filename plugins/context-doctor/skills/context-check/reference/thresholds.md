# Where the thresholds come from

Read this only when the user asks *why* a threshold sits where it does. It is
background, not instructions.

## The three claims that set the policy

**1. Degradation is a gradient that starts almost immediately — there is no cliff at 80%.**
Measurable losses on hard retrieval appear from ~2K tokens. No model tested has an
*effective* context anywhere near its *claimed* context; gaps of 50× to 250× are typical.

NoLiMa (ICML 2025) strips literal keyword overlap so the model must infer the
association rather than pattern-match a string — the harshest realistic retrieval test:

| Model | Claimed | Effective (≥85% of base) | Gap |
| :--- | ---: | ---: | ---: |
| Llama 4 Scout | 10M | 1K | 10,000× |
| Gemini 1.5 Pro | 2M | 2K | 1,000× |
| Gemini 2.0 Flash | 1M | 4K | 250× |
| Claude 3.5 Sonnet | 200K | 4K | 50× |
| GPT-4.1 | 1M | 16K | 62× |

At 32K tokens, 11 of 13 models scored below half their short-context baseline.

RULER (13 task types, gentler threshold) puts the general-task figure higher:
32–64K effective for most models that claim 128K+. Between the two you get the
usable bracket: **reliable precision to roughly 30–60K on general tasks;
sub-16K if the task is fine-grained latent retrieval.**

> NoLiMa is deliberately adversarial and covers one task. "Effective 4K" does
> not mean Claude breaks at 4,000 tokens. It means needle-precision erodes
> early. Broad summarisation and code navigation hold up far better.

**2. Compaction is itself lossy and risky.**

| Finding | Source |
| :--- | :--- |
| 40.4% of compaction transitions cause a degradation (1,009 Correct→Wrong against 1,486 Wrong→Correct across 12 fixed-interval summarisations) | *Self-Compacting LM Agents*, arXiv 2606.23525 |
| All compression methods scored below uncompressed on AppWorld; a compaction event adds +0.108 blocked/error actions at the very next step | *Reliable Context Compression*, arXiv 2608.06503 |
| Compression "converts some tasks that were reliably solved into tasks that are only intermittently solved" | same |

The shape of the correct policy falls out of two rows read together:

- Never compacting: **38.9%** — the worst option.
- Compacting on a timer: **41.4%** — barely better.
- Compacting selectively, when the agent is already off-track: **52.9%** — dramatically better.

And on pruning versus summarising (GPT-5, 50 tasks, *Less Context, Better Agents*, arXiv 2606.10209):

- Full retention: **71.0%** at 1.48M tokens
- Prune to last 5 tool calls: **79.0%** at 535K tokens
- Prune + targeted summarise: **91.6%**

Pruning stale tool output beats summarising the lot, at a third of the tokens.
The same paper notes the common "compact at 30% of remaining context" default
*"typically fires too late."*

**3. Focused beats full, and Claude shows the largest gap.**
On LongMemEval, all models scored higher on ~300-token focused prompts than on
~113K-token full prompts. Claude's gap was the largest — driven by abstention
under ambiguity. Opus 4 and Sonnet 4 scored *lower on full prompts than older
Claude models did*. Newer and smarter does not mean more robust to a bloated
context.

## Why the plugin computes two zones instead of one

Degradation is a function of **absolute token count** — 150K tokens dilute
attention the same amount whether the window is 200K or 1M. Auto-compaction
pressure is a function of **fraction of the configured window**. These are
independent, and either can be the binding constraint:

- On a 200K window you can hit auto-compaction while still well inside the
  green degradation zone.
- On a 1M window you can be deep into measurable degradation while nowhere
  near auto-compaction.

The plugin classifies both and reports the worse. `verdict.driver` says which
one is binding — `"degradation"` means quality, `"pressure"` means runway.

**Degradation zones (absolute tokens):**

| Zone | Tokens | What's happening |
| :--- | :--- | :--- |
| 🟢 Optimal | 0–150K | Well inside RULER's effective range. Precision intact. |
| 🟡 Watch | 150–350K | Positional bias and distractor effects measurable. |
| 🟠 Act | 350–600K | Attention meaningfully diluted. Missed details, re-reads, instruction drift. |
| 🔴 Degraded | 600–850K | Past every published effective-context measurement. |
| ⛔ Critical | 850K+ | No benchmark covers this. |

**Pressure zones (fraction of the effective auto-compact point):** 50% / 75% /
90% / 100%.

## Other findings that change the advice

From Chroma's 18-model study (194,480 LLM calls):

| Finding | What it changes |
| :--- | :--- |
| Retrieval was better from a randomly-shuffled haystack than a logically-structured one, across **all 18 models** | Coherent surrounding prose competes for attention. Dumping a whole well-written document is worse than you would assume. |
| A **single** near-miss distractor drops performance below baseline; four compound it; the effect amplifies with length | Near-duplicate versions of a file are worse than unrelated noise. This is why the report flags re-read files. |
| Low question-needle similarity degrades far faster with length | Vague questions over long context fail first. Ask precisely. |
| Position bias in generation favours the beginning, and *strengthens* with length | Put the instruction that matters at the top — of the prompt, of CLAUDE.md, of SKILL.md. |
| Claude has the lowest hallucination rates but abstains more as context grows | You get "I'm not sure" rather than confident fabrication — but you get more of it. |

Position sensitivity itself (*Lost in the Middle*, TACL 2024): a 22-point spread
between best and worst gold-document position for GPT-3.5, and with the gold
document buried mid-context it performed *worse than answering with no
documents at all*. Two caveats that undercut the obvious fixes — Claude-1.3
was dramatically flatter (4.2-point spread), and extended-context variants gave
**zero** benefit (GPT-3.5 4K vs 16K curves were "nearly superimposed"). A bigger
window does not buy better use of the window.

## Mechanism

Softmax over `n` positions forces the maximum attention weight toward zero as
`n` grows, so the attention distribution necessarily flattens. Non-informative
tokens accumulate probability mass, leading to dispersion and representational
collapse (Vasylenko et al., ICLR 2026). Sparse-attention variants (α-entmax)
extend usable length by up to 1000× on synthetic tasks — strong evidence the
softmax is the culprit rather than a symptom.

The useful mental model is Anthropic's: an **attention budget**, where "every
new token introduced depletes this budget by some amount." A performance
gradient, not a hard cliff.

## What survives compaction

| Mechanism | After compaction |
| :--- | :--- |
| System prompt, output style | ✅ Unchanged — not part of message history |
| Project-root `CLAUDE.md`, unscoped rules | ✅ Re-injected from disk |
| Auto memory | ✅ Re-injected from disk |
| Invoked skill bodies | ⚠️ Re-injected, capped at 5K tokens/skill and 25K total, oldest dropped first |
| Skill *descriptions* listing | ❌ Not re-injected — only skills actually invoked persist |
| Rules with `paths:` frontmatter | ❌ Lost until a matching file is read again |
| Nested `CLAUDE.md` in subdirectories | ❌ Lost until a file in that subdirectory is read again |

Two consequences worth telling a user who reports "it forgot the rules": if a
rule must survive compaction, drop its `paths:` frontmatter or move it to the
project-root `CLAUDE.md`. And since skill truncation keeps the *start* of the
file, the most important instructions go near the top of `SKILL.md`.

## Caveats

- **Benchmark task ≠ real task.** These figures are ordering, not calibration.
- **Model families differ enormously.** Cross-family transfer is unreliable.
- **No published Claude 4/5 long-context numbers.** RULER excludes Anthropic
  models entirely; NoLiMa's newest Claude entry is 3.5 Sonnet; Chroma's
  Claude-specific findings are qualitative (per-model figures appear only
  inside charts). Assume the current generation is better than the tables
  suggest — but Chroma found Opus 4 and Sonnet 4 scoring *lower* than older
  Claude models on full-context LongMemEval, so do not assume immunity.
- **The agentic-compaction evidence is all preprints**, and at least one frames
  its result as correlational rather than causal. The direction is consistent
  across independent groups; the magnitudes are not settled.
- **Anthropic's engineering post and Chroma's report are not independent** —
  the former cites the latter as its evidence base.
- **Training is closing the gap.** *CompactionRL* (arXiv 2607.05378) shows
  models trained specifically to compact recover most of the loss (+7.0 points
  on SWE-bench Verified for GLM-4.5-Air). This problem should shrink.

## Sources

**Peer-reviewed**

- Liu et al. (2024). [Lost in the Middle](https://arxiv.org/abs/2307.03172). *TACL*.
- Modarressi et al. (2025). [NoLiMa](https://proceedings.mlr.press/v267/modarressi25a.html). *ICML 2025*.
- Zhang et al. (2025). [Attention Entropy is a Key Factor](https://aclanthology.org/2025.acl-long.485/). *ACL 2025*.
- Vasylenko et al. (2026). [Long-Context Generalization with Sparse Attention](https://arxiv.org/abs/2506.16640). *ICLR 2026*.

**Preprints**

- Hsieh et al. (2024). [RULER](https://arxiv.org/abs/2404.06654)
- Nakanishi (2025). [Scalable-Softmax Is Superior for Attention](https://arxiv.org/abs/2501.19399)
- Lodha et al. (2026). [Less Context, Better Agents](https://arxiv.org/abs/2606.10209)
- Li et al. (2026). [Self-Compacting Language Model Agents](https://arxiv.org/abs/2606.23525)
- Min et al. (2026). [Toward Reliable Context Compression for Long-Horizon Agents](https://arxiv.org/abs/2608.06503)
- Li et al. (2026). [CompactionRL](https://arxiv.org/abs/2607.05378)

**Industry reports and documentation**

- Hong, Troynikov & Huber (2025). [Context Rot](https://www.trychroma.com/research/context-rot). Chroma.
- Anthropic (2025). [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
- Anthropic. [Explore the context window](https://code.claude.com/docs/en/context-window) · [Subagents](https://code.claude.com/docs/en/sub-agents)
