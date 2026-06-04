---
title: "Prompt Engineering: From Core Principles to Advanced Practice (3): Evaluation Principles"
lang: en
translationKey: prompt-engineering-core-principles-part3
slug: prompt-engineering-core-principles-part3
excerpt: "Part 3 of the Prompt Engineering: From Core Principles to Advanced Practice series, focused on evaluation principles and automated prompt optimization."
publishDate: '2026-02-10'
displayInBlog: false
tags:
  - "AI"
  - "Prompt Engineering"
  - "LLM"
  - "Large Language Models"
series:
  name: "Prompt Engineering: From Core Principles to Advanced Practice"
  part: 3
  total: 4
seo:
  title: "Prompt Engineering Evaluation Principles and Automation"
  description: "Review evaluation-driven prompt development, task-specific evals, logging, automation, and DSPy-based prompt optimization workflows."
  pageType: article
---
> This is part 3 of the four-part series "Prompt Engineering: From Core Principles to Advanced Practice." In the previous article, we covered promptfoo.

##### Evaluation Principles
```plain
1. Adopt eval-driven development
- **Evaluate early and often**: Write tightly scoped tests at every stage of development so problems are caught and corrected quickly.
- **Evaluate continuously**: Evaluation is an ongoing process, not a one-time task. Continuous evaluation keeps model behavior improving over time.

2. Design task-specific evals
- **Reflect real-world distributions**: Make sure evaluation tests represent production behavior instead of only checking idealized cases.
- **Make evaluation goals concrete**: Define specific goals and success criteria so the evaluation is targeted and actionable.

3. Log everything
- **Log during development**: Capture detailed logs so valuable eval cases can be mined later and used to improve the model.
- **Maintain traceability**: Logs make it possible to trace model decisions and outputs, which helps with analysis and optimization.

4. Automate when possible
- **Build structured evaluation systems**: Use evals that can be scored automatically to improve efficiency and objectivity while reducing manual bias.
- **Combine automated scoring with human judgment**: Automated scoring is efficient, but human review is still needed to keep results accurate and reasonable.

5. Maintain agreement
- **Calibrate automated scoring with human feedback**: Use human evaluation results to align automated scoring with human judgment and improve reliability.
- **Recalibrate regularly**: As models and usage scenarios change, recalibrate the evaluation system so it remains effective.

6. Avoid anti-patterns
- **Avoid overly generic metrics**: Do not rely only on academic metrics such as perplexity or BLEU. Choose metrics that fit the application.
- **Avoid biased design**: Make sure the eval dataset faithfully reflects production traffic patterns so the result is not distorted by data bias.
- **Avoid vibe-based evaluation**: Do not judge model performance by intuition alone. Use concrete data and evaluation metrics.
- **Value human feedback**: Do not ignore human review. Calibrate automated metrics against human evaluation to improve accuracy.
```

Together, these principles form evaluation best practices. They help developers design more effective and reliable evals, which improves AI model performance and reliability in production.

##### Eval References
- https://platform.openai.com/docs/guides/evaluation-best-practices
- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

#### 3.2 Automated Prompt Engineering
Manually designing and tuning prompts is time-consuming, requires deep expertise, and often still produces a suboptimal result. Automated prompt engineering has therefore become an important research direction. Its main methods fall into two categories:

- **Discrete Prompts**: These methods automatically generate or optimize human-readable prompts made of real text. They search and combine candidates within the existing vocabulary space. Common techniques include:
    - **Mining**: Extract templates from large corpora that connect inputs to outputs.
    - **Paraphrasing**: Rewrite a seed prompt or replace terms with synonyms to generate variants for testing.
    - **Reinforcement-learning-based methods, such as RLPrompt**: Train a policy network that generates discrete prompts with higher rewards, meaning better task performance.
- **Continuous Prompts / Soft Prompts**: Unlike discrete prompts, which operate on human-readable text, continuous prompts optimize a sequence of vectors directly in the model's embedding space. These "soft prompts" are unreadable to humans but can be more efficient for the model.
    - **Representative techniques**: Prefix-Tuning and P-tuning are typical examples. They add trainable continuous vectors before or inside the input sequence, freeze the main LLM parameters during training, and update only those prompt vectors.
    - **Pros and cons**: This approach often performs better and is more parameter-efficient, but it requires direct access to model weights and gradients, so it is incompatible with closed-source models that are only available through APIs.

As system complexity grows, manual prompt tuning becomes unmaintainable. **DSPy (Declarative Self-improving Language Programs)** introduces a paradigm shift: treat prompts as model parameters and let optimizers learn them automatically.

##### DSPy: The Core Idea, Programming Instead of Prompting
In DSPy, you define a **Signature** (what the inputs and outputs are) and a **Module** (the processing logic). The actual prompt text and few-shot examples are generated automatically by an **Optimizer** at compile time using evaluation data.

**The DSPy optimizer family:** Optimizers run against the training set, try different combinations of instructions and examples, and maximize the evaluation metric.

- **BootstrapFewShot / RandomSearch:** This is "automatic few-shot" prompting. A teacher model, usually a larger model, generates high-quality input-output examples for your program and selects the best K examples for the prompt.
- **MIPROv2 (Multi-prompt Instruction Proposal Optimizer):** Goes further by optimizing not only examples but also the best system instruction text using Bayesian optimization.
- **BootstrapFinetune:** Distills the results of prompt engineering into the weights of a smaller model, which is useful for aggressive cost or latency optimization.

Project: https://gitlab.mayfair-inc.com/liukai/llm-dspy-sample

```plain
"""
DSPy automated prompt engineering example
===========================

This example shows how to build a Chinese-to-English translator with DSPy,
and automatically optimize its prompt with the BootstrapFewShot optimizer.

Core concepts:
- Signature: declares the input-output contract
- Module: defines the execution logic
- Optimizer: automatically optimizes prompts and examples

Make sure the OPENAI_API_KEY environment variable is set before running
"""

import os
import json
import dspy
from dspy.teleprompt import BootstrapFewShot

# ============================================================
# Global Signature definition for sharing across functions
# ============================================================

class ChineseToEnglish(dspy.Signature):
    """Translate Chinese text into idiomatic English, covering conversational, written, or poetic styles."""
    chinese = dspy.InputField(desc="Chinese text to translate")
    english = dspy.OutputField(desc="idiomatic English translation")

class Assess(dspy.Signature):
    """Evaluate translation quality."""
    chinese = dspy.InputField(desc="original Chinese text")
    english = dspy.InputField(desc="translated English text")
    score = dspy.OutputField(desc="translation quality score from 1 to 5, where 5 is best")

# ============================================================
# Define Module
# ============================================================

class Translator(dspy.Module):
    """Translator module that uses ChainOfThought reasoning"""
    def __init__(self):
        super().__init__()
        self.prog = dspy.ChainOfThought(ChineseToEnglish)

    def forward(self, chinese: str):
        return self.prog(chinese=chinese)

def print_section(title: str, char: str = "="):
    """Print a separator and title"""
    print(f"\n{char * 60}")
    print(f"  {title}")
    print(f"{char * 60}")

def print_prompt_structure(compiled_module):
    """
    Pretty-print the compiled prompt structure
    """
    print_section("DSPy automatically generated prompt structure", "─")
    
    print("\n[System instruction]")
    print(f"  Task: {ChineseToEnglish.__doc__.strip()}")
    print(f"  Input field: chinese (Chinese text to translate)")
    print(f"  Output fields: reasoning (reasoning) + english (idiomatic English translation)")
    
    # Get demos from the compiled module state
    demos = []
    for name, predictor in compiled_module.named_predictors():
        state = predictor.dump_state()
        if 'demos' in state and state['demos']:
            demos.extend(state['demos'])
    
    if demos:
        print(f"\n[Automatically selected few-shot examples] total: {len(demos)}")
        print("  (DSPy automatically selects the most effective examples from the training set)")
        
        for i, demo in enumerate(demos, 1):
            print(f"\n  Example {i}:")
            print(f"    Chinese: {demo.get('chinese', 'N/A')}")
            if demo.get('english'):
                print(f"    English: {demo['english']}")
            if demo.get('reasoning'):
                reasoning = demo['reasoning']
                reasoning_preview = reasoning[:80] + "..." if len(reasoning) > 80 else reasoning
                print(f"    Reasoning: {reasoning_preview}")
            if demo.get('augmented'):
                print(f"    [Automatically bootstrapped example]")
    else:
        print("\n[Few-shot examples] none, using zero-shot")

def save_compiled_program(compiled_module, filepath: str):
    """
    Save the compiled program as a readable JSON file
    """
    output = {
        "task_description": ChineseToEnglish.__doc__.strip(),
        "input_fields": ["chinese"],
        "output_fields": ["reasoning", "english"],
        "selected_demos": [],
        "full_state": {}
    }
    
    # Get demos from the compiled module state
    for name, predictor in compiled_module.named_predictors():
        state = predictor.dump_state()
        output["full_state"][name] = {
            "signature": state.get("signature", {}),
            "demos_count": len(state.get("demos", []))
        }
        if 'demos' in state and state['demos']:
            for demo in state['demos']:
                demo_dict = {
                    "chinese": demo.get('chinese'),
                    "english": demo.get('english'),
                    "reasoning": demo.get('reasoning'),
                    "augmented": demo.get('augmented', False)
                }
                output["selected_demos"].append(demo_dict)
    
    with open(filepath, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print(f"\n💾 Compiled result saved to: {filepath}")

def compare_before_after(test_text: str, unoptimized: Translator, optimized: Translator):
    """
    Compare translation quality before and after optimization
    """
    print(f"\n  Input: {test_text}")
    
    # Before optimization
    result_before = unoptimized(chinese=test_text)
    print(f"  Before: {result_before.english}")
    
    # After optimization
    result_after = optimized(chinese=test_text)
    print(f"  After: {result_after.english}")
    
    if hasattr(result_after, 'reasoning') and result_after.reasoning:
        reasoning_preview = result_after.reasoning[:100] + "..." if len(result_after.reasoning) > 100 else result_after.reasoning
        print(f"  reasoning: {reasoning_preview}")

def main():
    # ============================================================
    # 1. Environment configuration
    # ============================================================
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        raise ValueError(
            "Please set the OPENAI_API_KEY environment variable\n"
            "For example: export OPENAI_API_KEY='your-api-key'"
        )

    lm = dspy.LM('openai/gpt-4o-mini', api_key=api_key)
    dspy.configure(lm=lm)

    print_section("🚀 DSPy automated prompt engineering demo")
    print("\n✅ LLM configured: gpt-4o-mini")

    # ============================================================
    # 2. Prepare training data
    # ============================================================
    trainset = [
        dspy.Example(
            chinese="Jue jue zi, the drinks at this shop are amazing!",
            english="This place is absolutely fire!"
        ).with_inputs('chinese'),

        dspy.Example(
            chinese="Yu qiong qian li mu, geng shang yi ceng lou.",
            english="To see a thousand miles further, one must ascend another story."
        ).with_inputs('chinese'),

        dspy.Example(
            chinese="This project is yyds!",
            english="This project is the GOAT!"
        ).with_inputs('chinese'),

        dspy.Example(
            chinese="I really like this young woman.",
            english="I absolutely adore this young lady."
        ).with_inputs('chinese'),

        dspy.Example(
            chinese="Ren sheng ru meng, yi zun hai lei jiang yue.",
            english="Life is but a dream, let me raise a cup to the river and moon."
        ).with_inputs('chinese'),

        dspy.Example(
            chinese="How are you? I am doing well, thank you.",
            english="How are you? I'm doing well, thank you."
        ).with_inputs('chinese'),

        dspy.Example(
            chinese="Ming yue ji shi you, ba jiu wen qing tian.",
            english="When does the bright moon appear? I raise my cup to question the sky."
        ).with_inputs('chinese'),

        dspy.Example(
            chinese="The visual effects in this movie are explosive!",
            english="The visual effects in this movie are absolutely mind-blowing!"
        ).with_inputs('chinese'),
    ]

    print(f"📚 Training set: {len(trainset)} examples covering colloquial language, poetry, and internet slang")

    # ============================================================
    # 3. Define the evaluation metric
    # ============================================================
    def ai_metric(gold, pred, trace=None):
        judge = dspy.Predict(Assess)
        try:
            result = judge(chinese=gold.chinese, english=pred.english)
            score_str = str(result.score).strip()
            score = int(''.join(filter(str.isdigit, score_str))[:1])
            return score >= 4
        except (ValueError, AttributeError, IndexError):
            return False

    # ============================================================
    # 4. Create an unoptimized translator for comparison
    # ============================================================
    unoptimized_translator = Translator()

    # ============================================================
    # 5. Compile and optimize
    # ============================================================
    print_section("🔄 Compiling and optimizing...")
    print("\n  DSPy is automatically:")
    print("  1. Trying different example combinations")
    print("  2. Using AI to evaluate translation quality")
    print("  3. Selecting the best few-shot examples")
    print("\n  (Please wait; this takes about 1-2 minutes...)")

    optimizer = BootstrapFewShot(
        metric=ai_metric,
        max_bootstrapped_demos=2,
        max_labeled_demos=4,
        max_rounds=1,
    )

    compiled_translator = optimizer.compile(
        Translator(),
        trainset=trainset
    )

    print("\n✅ Compilation and optimization complete!")

    # ============================================================
    # 6. Show the optimized prompt structure
    # ============================================================
    print_prompt_structure(compiled_translator)

    # ============================================================
    # 7. Compare before and after optimization
    # ============================================================
    print_section("Before and after optimization", "─")
    
    test_cases = [
        "Moonlight shines before my bed; I suspect it is frost on the ground.",
        "This is way too outrageous!",
        "Do not rejoice in external gains or grieve over personal losses.",
    ]
    
    for i, text in enumerate(test_cases, 1):
        print(f"\n[Comparison test {i}]")
        compare_before_after(text, unoptimized_translator, compiled_translator)

    # ============================================================
    # 8. Save the compiled result
    # ============================================================
    save_compiled_program(compiled_translator, "compiled_translator.json")

    # ============================================================
    # 9. Show the raw LLM call history, optional
    # ============================================================
    print_section("📜 Last LLM call details", "─")
    print("\n(Below is the full prompt DSPy sent to the LLM)")
    print("-" * 60)
    dspy.inspect_history(n=1)

    print_section("✨ Demo complete!")

if __name__ == "__main__":
    main()
```

Final optimized prompt

```plain
System message:

Your input fields are:
1. `chinese` (str): Chinese text to translate
Your output fields are:
1. `reasoning` (str): 
2. `english` (str): idiomatic English translation
All interactions will be structured in the following way, with the appropriate values filled in.

[[ ## chinese ## ]]
{chinese}

[[ ## reasoning ## ]]
{reasoning}

[[ ## english ## ]]
{english}

[[ ## completed ## ]]
In adhering to this structure, your objective is: 
        Translate Chinese text into idiomatic English, covering conversational, written, or poetic styles.


User message:

This is an example of the task, though some input or output fields are not supplied.

[[ ## chinese ## ]]
Yu qiong qian li mu, geng shang yi ceng lou.


Assistant message:

[[ ## reasoning ## ]]
Not supplied for this particular example. 

[[ ## english ## ]]
To see a thousand miles further, one must ascend another story.

[[ ## completed ## ]]


User message:

This is an example of the task, though some input or output fields are not supplied.

[[ ## chinese ## ]]
How are you? I am doing well, thank you.


Assistant message:

[[ ## reasoning ## ]]
Not supplied for this particular example. 

[[ ## english ## ]]
How are you? I'm doing well, thank you.

[[ ## completed ## ]]


User message:

[[ ## chinese ## ]]
Jue jue zi, the drinks at this shop are amazing!


Assistant message:

[[ ## reasoning ## ]]
The romanized phrase "jue jue zi" is internet slang used to express strong admiration, similar to saying "amazing" or "awesome" in English. The speaker is saying that the drinks at this shop are remarkably good.

[[ ## english ## ]]
This place is absolutely fantastic; the drinks are amazing!

[[ ## completed ## ]]


User message:

[[ ## chinese ## ]]
I really like this young woman.


Assistant message:

[[ ## reasoning ## ]]
The phrase expresses strong affection or admiration for a young woman. The wording is informal and affectionate, so a natural translation should preserve both the enthusiasm and the casual tone.

[[ ## english ## ]]
I really like this girl!

[[ ## completed ## ]]


User message:

[[ ## chinese ## ]]
Do not rejoice in external gains or grieve over personal losses.

Respond with the corresponding output fields, starting with the field `[[ ## reasoning ## ]]`, then `[[ ## english ## ]]`, and then ending with the marker for `[[ ## completed ## ]]`.


Response:

[[ ## reasoning ## ]]
This phrase encapsulates a philosophical viewpoint emphasizing emotional resilience and detachment. It suggests that one should not be overly elated by external possessions or circumstances, nor should one be excessively saddened by personal misfortunes. A natural English translation would reflect this deeper understanding and the balanced perspective on life.

[[ ## english ## ]]
One should not rejoice over material gains, nor be sorrowful over personal losses.

[[ ## completed ## ]]
```

Comparison tests

```plain
[Comparison test 1]
  Input: Moonlight shines before my bed; I suspect it is frost on the ground.
  Before: The moonlight before my bed, 
I suspect it’s frost on the ground.
  After: The bright moonlight shines before my bed, as if there's frost on the ground.
  reasoning: This couplet is a well-known line from the poem "Quiet Night Thoughts" by Li Bai. It beautiful...

[Comparison test 2]
  Input: This is way too outrageous!
  Before: This is absolutely ridiculous!
  After: This is just too ridiculous!
  reasoning: The phrase expresses incredulity or disbelief about a situation being wildly outrageous or absurd. "...

[Comparison test 3]
  Input: Do not rejoice in external gains or grieve over personal losses.
  Before: Do not rejoice over possessions, nor grieve over oneself.
  After: One should not rejoice over material gains, nor be sorrowful over personal losses.
  reasoning: This phrase encapsulates a philosophical viewpoint emphasizing emotional resilience and detachment. ...
```

Reference: [DSPy Optimizers Documentation](https://dspy.ai/learn/optimization/optimizers/)

Effective evaluation and automation can improve prompt quality, but we still need to secure prompts against an increasing number of malicious attacks.

---

---

> In the next article, we will cover security: prompt injection attacks and defensive practices. Stay tuned for the rest of the series.

**"Prompt Engineering: From Core Principles to Advanced Practice" Series**

1. Introduction: Why prompt engineering is a core capability for technical teams
2. promptfoo
3. **Evaluation principles** (this article)
4. Security: prompt injection attacks and defensive practices
