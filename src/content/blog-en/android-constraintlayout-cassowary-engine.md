---
title: "Android ConstraintLayout Deep Dive: From Cassowary Solving to Compose Constraints"
lang: en
translationKey: android-constraintlayout-cassowary-engine
slug: android-constraintlayout-cassowary-engine
excerpt: "A deep look at ConstraintLayout's Cassowary constraint solver, its O(n^3) performance ceiling, and how Compose constraints shift layout work toward deterministic O(n) placement."
publishDate: '2025-07-15'
tags:
- "Android"
- "ConstraintLayout"
- "Performance Optimization"
- "Jetpack Compose"
- "Cassowary"
seo:
  title: "Android ConstraintLayout: Cassowary Solving and Compose Constraints"
  description: "Explore ConstraintLayout's Cassowary solver, its performance limits, and practical layout optimization strategies across Views and Compose."
  pageType: article
---

A complex screen takes 12 ms in the measurement phase, and ConstraintLayout's `onMeasure` accounts for 8 ms of it. When that layout appears repeatedly inside RecyclerView items, the frame rate drops below 40. Replacing the same UI with nested LinearLayouts is actually faster. Wasn't ConstraintLayout supposed to optimize performance through flattening?

The problem is not at the API layer. It is in the constraint-solving engine: the Cassowary algorithm.

## The mathematical core of Cassowary

Cassowary is a **linear constraint solver** proposed by Greg Badros and Alan Borning in 1998, originally for GUI layout. Its core idea is to transform layout relationships into a set of linear equalities and inequalities, then find the optimal solution.

Each constraint falls into one of three types:

- **Equality constraint**: `viewA.left = viewB.right + 16`, for relative positioning
- **Inequality constraint**: `view.width >= 100`, for minimum width
- **Violable constraint**: `view.width = 200` marked with `medium` priority, which can be broken when layout space is insufficient

Constraints can conflict by priority. Cassowary handles this with a variant of the Simplex algorithm. It does not simply solve a system of equations once; it performs incremental updates whenever constraints change to avoid a full recomputation.

Mathematically, Cassowary maintains a linear program in standard form:

```text
Minimize objective function: sum(weighted penalties of violated constraints)
Subject to: A * x = b, x >= 0
```

Here `A` is the constraint matrix, `x` is the variable vector, with each widget's left, right, top, bottom, width, and height, and `b` is the constant vector. In the objective function, the penalty weight of "non-violable" constraints is extremely high. In the real implementation this is represented as `required`, with `Strength.REQUIRED = 1,000,000,000`. **Strong constraints** come next, such as match_parent. **Weak constraints** are the lowest, such as wrap_content.

## Cassowary in ConstraintLayout

ConstraintLayout did not implement Cassowary from scratch. It integrates Google's [constraintlayout/solver](https://github.com/androidx/constraintlayout/tree/main/solver) module, a standalone constraint-solving engine written in Java.

Every time `onMeasure` is called, the engine runs this flow:

```java
// Simplified ConstraintLayout measurement flow
void onMeasure(int widthSpec, int heightSpec) {
    // 1. Parse XML attributes into internal constraint objects
    parseConstraints(attrs);

    // 2. Build Cassowary formulas
    system.reset();
    for (Constraint c : constraints) {
        system.addConstraint(c.toCassowary()); // Convert to a linear equation
    }

    // 3. Run the solver
    system.solve();

    // 4. Read widget sizes and positions from the solved result
    for (Widget w : widgets) {
        w.setBounds(system.getValue(w.left), system.getValue(w.top),
                    system.getValue(w.width), system.getValue(w.height));
    }
}
```

The bottleneck is step three, `system.solve()`. Cassowary's theoretical worst-case complexity is **O(n^3)**, where n is the number of variables. For ConstraintLayout, the variable count equals widget count times six: left, right, top, bottom, width, and height. A layout with 10 widgets already has 60 variables, so the matrix work is not trivial.

One issue I have hit in real projects is **bidirectional dependency**: A depends on B's position, while B also depends on A's size. In that case, the solver needs extra pivot operations to remove the cycle. The performance regression is very visible. With the same number of widgets, solving time can double.

### The extra cost of Barrier and Chain

Barrier and Chain are advanced ConstraintLayout features, but in the solver they introduce **extra variables and implicit constraints**:

```xml
<!-- A simple Barrier -->
<Barrier
    android:id="@+id/barrier"
    app:barrierDirection="end"
    app:constraint_referenced_ids="view1,view2" />
```

This XML is parsed as `barrier.position = max(view1.right, view2.right)`. Cassowary handles linear constraints, but `max` is **nonlinear**. The solver works around this by introducing an auxiliary variable `s` and two inequalities:

```text
s >= view1.right
s >= view2.right
barrier.position = s
```

Then the objective function **minimizes `s`**, so `s` naturally converges to the max value. A single Barrier adds at least one variable and two constraints. Chain is more complex because it needs bidirectional constraints to simulate weight distribution. These seemingly flat layout declarations are still feeding Cassowary more variables behind the scenes.

## Constraint layout in Compose: from solver to declarative DSL

Compose `ConstraintLayout` is implemented **very differently** from the View-system version. It does not need to run Cassowary during measurement, because Compose's measurement model is already single-pass.

```kotlin
ConstraintLayout(
    modifier = Modifier.fillMaxWidth()
) {
    val (title, subtitle, image) = createRefs()

    Text("Title", modifier = Modifier.constrainAs(title) {
        top.linkTo(parent.top, 16.dp)
        start.linkTo(parent.start, 16.dp)
    })

    Text("Subtitle", modifier = Modifier.constrainAs(subtitle) {
        top.linkTo(title.bottom, 8.dp)
        start.linkTo(title.start)
        end.linkTo(image.start, 16.dp)
        width = Dimension.fillToConstraints
    })

    Image(painter, modifier = Modifier.constrainAs(image) {
        top.linkTo(title.top)
        end.linkTo(parent.end, 16.dp)
    })
}
```

The constraint DSL looks similar to the XML version, but the execution path underneath is completely different. Compose does not need an incremental solver. Its layout phase is already "recompose, then relayout." Constraint declarations do not trigger matrix operations; they are converted into deterministic position calculations during layout.

`linkTo` is essentially setting a `Placeable` offset, not creating a mathematical equation:

```text
// Layout logic of Compose ConstraintLayout, simplified pseudocode
fun layout() {
    title.x = 16; title.y = 16
    subtitle.y = title.bottom + 8
    subtitle.x = title.x
    subtitle.width = image.x - subtitle.x - 16
    image.x = parentEnd - 16; image.y = title.y
}
```

Because the dependency direction in the constraint graph is one-way, subtitle depends on title while image is independent of subtitle, Compose can calculate nodes in dependency order and finish in O(n). The View-system ConstraintLayout must assume arbitrary constraint topology, so it has to use a general-purpose solver.

## Where the two architectures diverge

The View-system ConstraintLayout carries historical baggage. It has to support `MATCH_PARENT`, `WRAP_CONTENT`, percentage sizes, Guideline, Group, and more. These concepts came from different Android eras and design ideas, and they were ultimately folded into the Cassowary framework. The result is a rich API surface with uneven solving paths.

Compose has a different design philosophy. The measurement phase only deals with **size negotiation**: children report the size ranges they can accept, and the parent chooses from them. Position calculation is moved entirely to the layout phase. There is no cyclic dependency where measurement already needs to know final position. This removes the need for a constraint solver at the root.

Another key difference is `requestLayout()` in the View system. It can trigger remeasurement along the whole path from the root node to the target node. ConstraintLayout then adds its own solver cost on top, and the two combine into worse performance. Compose's local recomposition is more precise: only Composables whose constraints actually change need to relayout.

## Practical guidance

**In the View system, do not blindly believe that "flat means fast."** Once a layout has more than 15 constraints or more than 30 variables, use systrace or Android Studio Profiler to measure the actual `onMeasure` cost. If it exceeds 2 ms, it is worth splitting the layout or replacing it with FrameLayout plus manual layout. Two nested LinearLayouts are often faster than one complex ConstraintLayout: two O(n) linear passes versus O(n^3) matrix solving. The math has already decided the winner.

`MotionLayout` debug mode can print solving time for each frame directly. My experience on complex animation pages: if Cassowary solving exceeds 1.2 ms within a frame, frame drops are almost unavoidable.

**In Compose, the cost of constraint layout is mostly design-time cognitive cost**, not runtime overhead. The only thing to watch is dependency direction when the constraint DSL references deeply nested components. Make sure the constraint graph has no implicit cycle. Compose will not check that for you, but the layout result may fail to align.
