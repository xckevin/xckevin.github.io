---
title: "APK Decompilation and Recompilation: From Basics to Practical Workflows"
lang: en
translationKey: android-apk-decompile-recompile
slug: android-apk-decompile-recompile
excerpt: "A practical guide to Android APK decompilation, modification, recompilation, AAR dependency integration, and APK signing with apktool and related tools."
publishDate: '2025-02-14'
tags:
- "Android"
- "Reverse Engineering"
- "APK"
- "Security"
seo:
  title: "Android APK Decompilation and Recompilation: apktool, Smali, AARs, and Signing"
  description: "Learn the APK reverse engineering workflow: decompile with apktool, modify resources and smali, integrate AARs, rebuild, sign, and verify."
  pageType: article
---
Android app decompilation and recompilation are important skills in app development and reverse engineering. Whether you are modifying an existing app or debugging and fixing a specific issue, understanding the complete APK workflow is essential. This tutorial starts with the basics, explains the core techniques behind APK decompilation and recompilation, and then moves into more advanced tasks such as integrating AAR dependencies and signing rebuilt APKs.

---

## Introduction

Android apps are usually distributed as APK files. Most developers compile and sometimes protect APKs to safeguard code and resources. In some scenarios, however, you may need to decompile an APK, such as fixing an urgent issue, analyzing the resource structure, or performing secondary development.

`apktool` is a widely used decompilation tool that can decode and rebuild APKs. Combined with tools such as `baksmali`, `d8`, and `apksigner`, it can support a full workflow from decompilation and modification to repackaging and signing.

---

## APK File Structure and Basics

Before getting into specific operations, it helps to understand the basic structure of an APK file. A typical unzipped APK contains the following items:

### Main Components of an APK

- `META-INF/`: stores signing information.
- `res/`: stores app resources such as layouts, images, and strings.
- `AndroidManifest.xml`: the app manifest, which describes the app's basic configuration.
- `classes.dex`: contains the app's Java bytecode.
- `lib/`: stores native C/C++ libraries, such as `.so` files.
- `assets/`: stores static assets that can be accessed directly.
- `resources.arsc`: contains the index of all resources and their binary representation.

### Toolchain Overview

This tutorial uses the following tools:

1. `apktool`: decompiles and rebuilds APKs.
2. `baksmali` and `smali`: convert DEX files into readable `.smali` files and support the reverse operation.
3. `d8`: converts `.jar` files into DEX format.
4. `apksigner`: Android's official signing tool for signing APKs.
5. `keytool`: generates keystores.

---

## Decompiling an APK: Extracting Code and Resources

### 1. Install apktool

First, make sure `apktool` is installed. One installation method is:

```bash
wget https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool
wget https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool.jar
chmod +x apktool
sudo mv apktool /usr/local/bin
sudo mv apktool.jar /usr/local/bin
```

### 2. Decompile the APK

Use `apktool` to extract resources and code from the APK:

```bash
apktool d app.apk -o app_decoded
```

Here, `-o app_decoded` specifies the output directory for the decoded files.

### 3. Inspect the Decompilation Output

Enter the `app_decoded` directory. You should see files and directories such as:

- `AndroidManifest.xml`: converted into readable XML.
- `res/`: contains all resource files.
- `smali/`: stores the app's `.smali` bytecode files.

---

## Recompiling an APK: From Modification to Output

### 1. Modify the Contents

Make the required changes in the decompiled directory. For example:

- Modify layout files under `res/layout`.
- Modify the manifest file, `AndroidManifest.xml`.
- Add or remove bytecode files under `smali/`.

### 2. Recompile

After the changes are complete, rebuild the APK:

```bash
apktool b app_decoded -o app_rebuilt.apk
```

Here, `app_decoded` is the modified folder, and `-o app_rebuilt.apk` specifies the generated APK file name.

---

## Manually Integrating AAR Dependencies

When modifying decompiled code, you may need to introduce additional AAR dependencies. In that case, you need to integrate them manually.

### 1. Extract the AAR File

Use `unzip` to extract the AAR file:

```bash
unzip library.aar -d library_extracted
```

After extraction, you get a structure like this:

- `classes.jar`: bytecode file.
- `res/`: resource files.
- `AndroidManifest.xml`: the library manifest.

### 2. Merge Resources

Copy the contents of the AAR's `res/` directory into the APK's `res/` directory.

### 3. Convert the JAR to DEX

Use `d8` to convert `classes.jar` into `classes.dex`:

```bash
d8 library_extracted/classes.jar --output library_dex/
```

### 4. Convert to smali Files

Use `baksmali` to convert the DEX file into smali:

```bash
java -jar baksmali.jar d library_dex/classes.dex -o smali_output/
```

### 5. Merge smali Files

Copy the generated smali files into the decompiled APK's `smali/` directory.

---

## Signing the APK: Generate a Keystore and Sign

The rebuilt APK is unsigned by default. Before installing it on a device, you need to sign it.

### 1. Generate a Keystore

Use `keytool` to generate a key:

```bash
keytool -genkey -v -keystore my-release-key.keystore -keyalg RSA -keysize 2048 -validity 10000 -alias my-key
```

### 2. Sign the APK

Use `apksigner` to sign the APK:

```bash
apksigner sign --ks my-release-key.keystore --ks-key-alias my-key --out app_signed.apk app_rebuilt.apk
```

### 3. Verify the Signature

Use `apksigner` to verify whether signing succeeded:

```bash
apksigner verify app_signed.apk
```

---

## Common Issues and Fixes

1. **Decompilation error: resource parsing failed**
   - Try using the `--use-aapt2` option:

```bash
apktool d app.apk --use-aapt2
```

2. **Signing failure: V1/V2 signature issue**
   - Prefer `apksigner`, which supports modern APK signing schemes.

---

## Summary

After this tutorial, you should understand the full APK workflow: decompilation, modification, recompilation, and signing. These skills are useful not only for simple resource replacement but also for more complex engineering tasks. If you run into issues in practice, leave a comment and continue the discussion.
