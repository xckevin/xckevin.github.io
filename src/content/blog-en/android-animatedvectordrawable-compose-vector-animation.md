---
title: "AnimatedVectorDrawable to Compose Vector Animation"
lang: en
translationKey: android-animatedvectordrawable-compose-vector-animation
slug: android-animatedvectordrawable-compose-vector-animation
excerpt: "How AnimatedVectorDrawable bridges ObjectAnimator to VectorDrawable nodes, and how Compose reuses the same AVD model."
publishDate: '2026-07-24'
tags:
- "Android"
- "AnimatedVectorDrawable"
- "Jetpack Compose"
seo:
  title: "AnimatedVectorDrawable internals and Compose vector animation"
  description: "How AnimatedVectorDrawable drives VectorDrawable nodes through ObjectAnimator, including pathData pitfalls and Compose's declarative wrapper."
  pageType: article
---

## Tracing Back from an Icon Animation

While working on an icon transition animation recently, I used AnimatedVectorDrawable to morph a play/pause button. It worked, but one detail made me curious: how does the `android:name` in a `<target>` tag actually match a path inside VectorDrawable, and what is its relationship to ObjectAnimator?

Tracing this question into the source code, I found AVD's design is more subtle than it first appears—it is essentially a lightweight bridge layer; the real work is done by ObjectAnimator.

## AVD Does Not Run Animations; It Is the Host for Animators

AnimatedVectorDrawable itself performs no animation computation. It owns a set of ObjectAnimators, and each Animator drives a named node inside the VectorDrawable.

The XML structure of an AVD has three layers:

```xml
<animated-vector xmlns:android="..."
    android:drawable="@drawable/ic_play_pause">
    <target
        android:name="left_bar"
        android:animation="@animator/left_bar_rotate" />
    <target
        android:name="right_bar"
        android:animation="@animator/right_bar_rotate" />
</animated-vector>
```

Every `<target>` is a mapping: **the name must exactly match the `android:name` of a Group or Path in the VectorDrawable**. The XML referenced by `animation` is parsed by AnimatorInflater into a set of ObjectAnimators.

Simply put, AVD is only a container for Animators; ObjectAnimator is the engine, and the named nodes inside the VectorDrawable are the targets being manipulated.

## VectorDrawable's Named Tree

VectorDrawable is internally a Group/Path tree, where each node can have an `android:name`:

```xml
<vector xmlns:android="..."
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
    <group android:name="rotation_group"
        android:pivotX="12" android:pivotY="12">
        <path
            android:name="left_bar"
            android:fillColor="#FF000000"
            android:pathData="M6,6 L10,6 L10,18 L6,18 Z" />
    </group>
</vector>
```

When AVD starts, it calls `VectorDrawable.getTargetByName(name)` to traverse the entire tree and find the corresponding **VGroup** or **VFullPath** object. Once found, the ObjectAnimator directly manipulates the properties of these objects through PropertyValuesHolder—**no reflection is needed**, because both VGroup and VFullPath implement the corresponding getters and setters.

VGroup internally maintains a 3×3 transformation matrix and calls `invalidateSelf()` after every property change to trigger redrawing. The call chain is very direct.

## How ObjectAnimator Drives Node Properties

ObjectAnimator matches setters through `propertyName`, and there is an implicit naming convention here:

```xml
<objectAnimator xmlns:android="..."
    android:propertyName="rotation"
    android:duration="300"
    android:valueFrom="0"
    android:valueTo="180" />
```

When `propertyName="rotation"`, the Animator uses reflection to call `VGroup.setRotation(float)`. Likewise, `pivotX` maps to `setPivotX()`, and `scaleY` maps to `setScaleY()`.

Common property mappings:

| propertyName | Target node type | Behavior |
|---|---|---|
| rotation | Group | Matrix rotation |
| pivotX / pivotY | Group | Transform center point |
| scaleX / scaleY | Group | Matrix scaling |
| translateX / translateY | Group | Matrix translation |
| pathData | Path | Path data replacement |
| fillColor | Path | Fill color gradient |
| trimPathStart / End / Offset | Path | Path trimming |
| strokeColor / strokeWidth | Path | Stroke properties |

Group-level animations perform matrix transforms, while Path-level animations perform property value replacement. The two can run in parallel—a Group can rotate while its child Path independently animates its fillColor, without interfering with each other.

## The pathData Animation Pitfall: The Structure Must Match

pathData animation is the easiest to misunderstand. It does not interpolate the coordinates of two arbitrary paths frame by frame. Instead, it requires the source and target paths to have **exactly the same command structure**—the command types, count, and order must be identical; only the coordinate parameters differ.

```xml
<objectAnimator
    android:propertyName="pathData"
    android:valueFrom="M12,2 L2,22 L22,22 Z"
    android:valueTo="M12,2 L2,12 L22,12 Z"
    android:valueType="pathType"
    android:duration="300" />
```

The SDK's built-in PathParser compares the command sequences of both paths when parsing. If the structures do not match, it does not throw an exception—the path simply jumps straight to the final state. The animation "fails" silently, with no error message. This is the most common blind spot when troubleshooting.

One pitfall I encountered was on Android 5.0, where certain complex pathData values caused `IllegalArgumentException: Unknown pattern`. Tracing into the source code revealed that PathParser's regular expression matching was only improved in later versions; on older versions, specific path command combinations would crash directly. The solution is to manually ensure the commands in both `pathData` values are exactly identical, or degrade to a static icon switch on older versions.

## Compose's Declarative Paradigm: AnimatedImageVector

The problem with AVD is not its functionality but its mental overhead: you need to maintain three files at the same time—the VectorDrawable XML, the Animator XML, and the AVD XML—and changing a node name requires checking three reference chains one by one.

Compose flips the model. It does not reinvent a vector animation engine; instead, it directly reuses the existing AVD XML resources and drives playback with declarative state:

```kotlin
val image = AnimatedImageVector.animatedVectorResource(R.drawable.avd_play_to_pause)
var atEnd by remember { mutableStateOf(false) }

Icon(
    painter = rememberAnimatedVectorPainter(image, atEnd),
    contentDescription = null,
    modifier = Modifier.clickable { atEnd = !atEnd }
)
```

`AnimatedImageVector.animatedVectorResource()` still loads the same `<animated-vector>` XML resource. `rememberAnimatedVectorPainter` uses the passed-in `atEnd` boolean to trigger the already-defined ObjectAnimator animation between the start and end states; there is no method named `animateTo`. In other words, what Compose solves at this layer is avoiding the View-layer boilerplate of an ImageView plus a Drawable stub. The animation definition itself—name matching, propertyName, and pathData structural consistency—is still entirely carried by the AVD XML, so none of the pitfalls mentioned above disappear.

## Bridging View to Compose: The Lowest-Cost Migration

Don't want to migrate existing AVD resources? Bridge them directly with DrawablePainter:

```kotlin
val drawable = remember {
    AnimatedVectorDrawableCompat.create(context, R.drawable.avd_icon)
}
Image(
    painter = rememberDrawablePainter(drawable),
    contentDescription = null,
    modifier = Modifier.clickable { drawable.start() }
)
```

This approach keeps a View-system Drawable running inside Compose. `invalidateSelf()` ultimately delegates to DrawablePainter to trigger recomposition. The path is closed, but there is an extra layer of bridging overhead. For existing projects, this is the most cost-effective transitional approach.

## How I Choose

In real projects, my criteria are:

1. **Simple switching**: use Compose's `AnimatedContent` or `Crossfade`; you don't need vector animation.
2. **Continuous transformation of a single node** (rotation, scaling, path morphing): the AVD XML approach is the most mature; Vector Asset Studio can import SVG directly and generate a template.
3. **Compose-first new projects**: `AnimatedImageVector` + `rememberAnimatedVectorPainter` is sufficient. It comes from the separate artifact `androidx.compose.animation:animation-graphics`, supports down to minSdk 21 (the same minimum as Compose itself), and does not require API 33. The animation definition is still the AVD XML behind the scenes.
4. **Older-version compatibility**: use AppCompat's `AnimatedVectorDrawableCompat`, but ProGuard rules must keep the classes under the `android.support.graphics.drawable` path; otherwise, after class-name obfuscation the animation fails silently.

After understanding AVD's ObjectAnimator-driven model, when you encounter "animation not working," you know to check three links: whether the name matches, whether propertyName has a corresponding setter, and whether the pathData command structure is consistent. Once the principles are clear, troubleshooting efficiency naturally improves.
