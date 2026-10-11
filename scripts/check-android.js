#!/usr/bin/env node
/**
 * Static checks for the Android client.
 *
 * The Android SDK is not available in every environment (and never in CI
 * without a JDK image), so these checks cover what can be verified from the
 * sources alone:
 *
 *  - every R.<type>.<name> referenced from Java exists in res/
 *  - every layout id referenced from Java exists in some layout
 *  - every class named in the manifest exists under src/main/java
 *  - no AndroidX, Kotlin or Compose dependency crept in
 *  - no AI provider key or other credential is compiled into the app
 *  - the allowlist on the phone matches the allowlist on the server
 *
 * This is a consistency check, not a compiler: it cannot prove the app builds.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = path.join(ROOT, 'android', 'app', 'src', 'main');
const RES = path.join(APP, 'res');
const JAVA = path.join(APP, 'java');
const TEST_JAVA = path.join(APP.replace(`${path.sep}main`, `${path.sep}test`), 'java');

const errors = [];
const notes = [];

function walk(dir, extensions = []) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(full, extensions));
    } else if (extensions.length === 0 || extensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(full);
    }
  }
  return found;
}

/** Collect every declared resource name by type: { string: Set, id: Set, ... } */
function collectResources() {
  const byType = new Map();
  const add = (type, name) => {
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(name);
  };

  for (const file of walk(RES)) {
    if (!file.endsWith('.xml')) continue;
    const source = fs.readFileSync(file, 'utf8');
    const isValues = path.basename(path.dirname(file)).startsWith('values');
    // <string name="x">, <color name="x">, <style name="x">, <item name="x">
    for (const match of source.matchAll(/<([a-zA-Z-]+)[^>]*\bname="([^"]+)"/g)) {
      const tag = match[1];
      const name = match[2].replace(/\./g, '_');
      if (isValues && tag === 'string') add('string', name);
      else if (isValues && tag === 'color') add('color', name);
      else if (isValues && tag === 'style') add('style', name);
      else if (isValues && tag === 'dimen') add('dimen', name);
      else if (isValues && tag === 'string-array') add('array', name);
      else if (isValues && tag === 'declare-styleable') add('styleable', name);
      else if (isValues) add(tag, name);
    }
    // Every @+id/foo declared anywhere (layouts, menus, xml configs)
    for (const match of source.matchAll(/@\+id\/([A-Za-z_][A-Za-z0-9_]*)/g)) {
      add('id', match[1]);
    }
    // <item android:id="@android:id/..."> is a framework id; ignored on purpose.
  }

  for (const file of walk(RES, ['.xml'])) {
    if (file.includes(`${path.sep}layout${path.sep}`)) add('layout', path.basename(file, '.xml'));
  }
  for (const dir of ['drawable', 'mipmap', 'drawable-anydpi']) {
    const full = path.join(RES, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      add('drawable', file.replace(/\.[a-z]+$/, ''));
    }
  }
  const mipmapDirs = fs.existsSync(RES)
    ? fs.readdirSync(RES).filter((name) => name.startsWith('mipmap-'))
    : [];
  for (const dir of mipmapDirs) {
    for (const file of fs.readdirSync(path.join(RES, dir))) {
      add('mipmap', file.replace(/\.[a-z]+$/, ''));
    }
  }
  for (const file of walk(path.join(RES, 'xml'), ['.xml'])) {
    add('xml', path.basename(file, '.xml'));
  }
  return byType;
}

function collectJavaFiles() {
  // Main and unit-test sources: the same rules apply to both.
  return [...walk(JAVA, ['.java']), ...walk(TEST_JAVA, ['.java'])];
}

const resources = collectResources();
const javaFiles = collectJavaFiles();

if (javaFiles.length === 0) {
  errors.push('no Java sources found under android/app/src/main/java');
}

/* ------------------------------------------------------------------ */
/* 1. Every R.* reference resolves                                       */
/* ------------------------------------------------------------------ */
const ignoredResourceTypes = new Set(['id']); // ids are checked separately
for (const file of javaFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);
  for (const match of source.matchAll(/(^|[^.\w])R\.([a-z]+)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const type = match[2];
    const name = match[3];
    if (ignoredResourceTypes.has(type)) continue;
    const declared = resources.get(type);
    if (!declared || !declared.has(name)) {
      errors.push(`${relative}: R.${type}.${name} is not declared in res/`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Every findViewById / R.id reference exists in a layout            */
/* ------------------------------------------------------------------ */
const declaredIds = resources.get('id') ?? new Set();
for (const file of javaFiles.filter((file) => file.startsWith(JAVA))) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);
  for (const match of source.matchAll(/\bR\.id\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (!declaredIds.has(match[1])) {
      errors.push(`${relative}: R.id.${match[1]} is not declared in any layout`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Every import of our own code resolves to a source file            */
/*    A missing source file is otherwise invisible until javac runs,    */
/*    which on a phone-less CI machine is five minutes too late.         */
/* ------------------------------------------------------------------ */
const declaredClasses = new Set(
  javaFiles.map((file) =>
    path
      .relative(APP, file)
      .replace(/\.java$/, '')
      .replace(/^src[\\/]/, '')
      .split(/[\\/]/)
      .slice(1)
      .join('.')),
);
for (const file of javaFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);
  for (const match of source.matchAll(/^import\s+(?:static\s+)?(com\.nexus\.phoneagent\.[\w.]+)\s*;/gm)) {
    const imported = match[1];
    if (imported === 'com.nexus.phoneagent.R' || imported.startsWith('com.nexus.phoneagent.R.')) continue;
    if (!declaredClasses.has(imported)) {
      errors.push(`${relative}: imports ${imported}, which has no source file`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. The manifest only names classes that exist                        */
/* ------------------------------------------------------------------ */
const manifestPath = path.join(APP, 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) {
  errors.push('android/app/src/main/AndroidManifest.xml is missing');
} else {
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  const appGradlePath = path.join(ROOT, 'android', 'app', 'build.gradle');
  const appGradle = fs.existsSync(appGradlePath) ? fs.readFileSync(appGradlePath, 'utf8') : '';
  const namespace = (appGradle.match(/namespace\s+['"]([^'"]+)['"]/) ?? [])[1];
  const packageName = (manifest.match(/package="([^"]+)"/) ?? [])[1] ?? namespace;
  if (!packageName) {
    errors.push('neither the manifest package nor the Gradle namespace is set');
  } else {
    for (const match of manifest.matchAll(/android:name="(\.[A-Za-z][A-Za-z0-9_.]*)"/g)) {
      const className = match[1].startsWith('.') ? packageName + match[1] : match[1];
      const file = path.join(JAVA, className.replace(/\./g, path.sep) + '.java');
      if (!fs.existsSync(file)) {
        errors.push(`AndroidManifest.xml: ${className} has no source file`);
      }
    }
    const javaPackages = new Set(
      collectJavaFiles()
        .filter((file) => file.startsWith(JAVA))
        .map((file) => path.relative(JAVA, file).split(path.sep).slice(0, -1).join('.')),
    );
    for (const javaPackage of javaPackages) {
      if (!javaPackage.startsWith(packageName)) {
        errors.push(`package ${javaPackage} is outside the application id ${packageName}`);
      }
    }
  }

  // The accessibility service must point at its configuration resource.
  if (!/@xml\/accessibility_service_config/.test(manifest)) {
    errors.push('the accessibility service does not reference @xml/accessibility_service_config');
  }
  if (!fs.existsSync(path.join(RES, 'xml', 'accessibility_service_config.xml'))) {
    errors.push('res/xml/accessibility_service_config.xml is missing');
  }
  for (const block of manifest.match(/<service\b[\s\S]*?\/?>/g) ?? []) {
    if (!/NexusAccessibilityService/.test(block)) continue;
    if (/android:exported="true"/.test(block)) {
      errors.push('the accessibility service must not be exported');
    }
    if (!/android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"/.test(block)) {
      errors.push('the accessibility service must require BIND_ACCESSIBILITY_SERVICE itself');
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. No AndroidX, Kotlin or Compose anywhere in the client             */
/* ------------------------------------------------------------------ */
for (const file of javaFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(ROOT, file);
  if (/^import androidx\./m.test(source)) {
    errors.push(`${relative}: AndroidX is not allowed in this project`);
  }
  if (/^import kotlin[x.]?/m.test(source)) {
    errors.push(`${relative}: Kotlin is not allowed; this client is Java only`);
  }
}
const gradleFiles = [
  path.join(ROOT, 'android', 'build.gradle'),
  path.join(ROOT, 'android', 'app', 'build.gradle'),
  path.join(ROOT, 'android', 'settings.gradle'),
];
for (const file of gradleFiles) {
  if (!fs.existsSync(file)) {
    errors.push(`${path.relative(ROOT, file)} is missing`);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  if (/androidx|com\.android\.library|org\.jetbrains\.kotlin/.test(source)) {
    errors.push(`${path.relative(ROOT, file)}: AndroidX or Kotlin dependency found`);
  }
}

/* ------------------------------------------------------------------ */
/* 5. No credential or AI key compiled into the client                  */
/* ------------------------------------------------------------------ */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\b(?:api[_-]?key|apikey)\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i,
  /OPENAI_API_KEY\s*=\s*["'][^"']+["']/,
];
for (const file of [...javaFiles, ...walk(RES, ['.xml'])]) {
  const source = fs.readFileSync(file, 'utf8');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(source)) {
      errors.push(`${path.relative(ROOT, file)}: a credential-looking value is embedded`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6. The phone allowlist matches the server allowlist                  */
/* ------------------------------------------------------------------ */
const serverActions = path.join(ROOT, 'server', 'src', 'policies', 'actionSchema.js');
const phonePolicy = path.join(JAVA, 'com', 'nexus', 'phoneagent', 'policy', 'LocalPolicy.java');
if (fs.existsSync(serverActions) && fs.existsSync(phonePolicy)) {
  const serverSource = fs.readFileSync(serverActions, 'utf8');
  const phoneSource = fs.readFileSync(phonePolicy, 'utf8');

  const actionBlock = serverSource.match(/export const ACTION_TYPES = Object\.freeze\(\[([\s\S]*?)\]\)/);
  const settingsBlock = serverSource.match(/export const OPEN_SETTINGS_TARGETS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  const serverTypes = new Set((actionBlock?.[1] ?? '').match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, '')) ?? []);
  const serverTargets = new Set((settingsBlock?.[1] ?? '').match(/'([a-z_]+)'/g)?.map((s) => s.replace(/'/g, '')) ?? []);

  const phoneBlock = phoneSource.match(/ALLOWED_TYPES = new HashSet<>\(Arrays\.asList\(([\s\S]*?)\)\)/);
  const phoneTypes = new Set((phoneBlock?.[1] ?? '').match(/"([a-z_]+)"/g)?.map((s) => s.replace(/"/g, '')) ?? []);
  const phoneTargetsBlock = phoneSource.match(/ALLOWED_SETTINGS_TARGETS = new HashSet<>\(Arrays\.asList\(([\s\S]*?)\)\)/);
  const phoneTargets = new Set((phoneTargetsBlock?.[1] ?? '').match(/"([a-z_]+)"/g)?.map((s) => s.replace(/"/g, '')) ?? []);

  for (const type of serverTypes) {
    if (!phoneTypes.has(type)) errors.push(`LocalPolicy.java is missing the action type "${type}"`);
  }
  for (const type of phoneTypes) {
    if (!serverTypes.has(type)) errors.push(`LocalPolicy.java allows "${type}", which the server does not know`);
  }
  for (const target of serverTargets) {
    if (!phoneTargets.has(target)) errors.push(`LocalPolicy.java is missing the settings target "${target}"`);
  }
  if (serverTypes.size > 0) {
    notes.push(`allowlist in sync: ${serverTypes.size} action types, ${serverTargets.size} settings targets`);
  }
} else {
  errors.push('cannot compare the allowlists: server/src/policies/actionSchema.js or LocalPolicy.java is missing');
}

/* ------------------------------------------------------------------ */
/* 7. The protocol version matches on both sides                        */
/* ------------------------------------------------------------------ */
const serverProtocol = path.join(ROOT, 'server', 'src', 'websocket', 'protocol.js');
const phoneProtocol = path.join(JAVA, 'com', 'nexus', 'phoneagent', 'protocol', 'Protocol.java');
if (fs.existsSync(serverProtocol) && fs.existsSync(phoneProtocol)) {
  const serverVersion = fs.readFileSync(serverProtocol, 'utf8').match(/PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1];
  const phoneVersion = fs.readFileSync(phoneProtocol, 'utf8').match(/PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1];
  if (!serverVersion || !phoneVersion) {
    errors.push('cannot read PROTOCOL_VERSION from one side of the protocol');
  } else if (serverVersion !== phoneVersion) {
    errors.push(`protocol version mismatch: server ${serverVersion}, phone ${phoneVersion}`);
  } else {
    notes.push(`protocol version ${serverVersion} on both sides`);
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */
if (errors.length > 0) {
  console.error(`android:check failed (${errors.length} problem${errors.length === 1 ? '' : 's'})`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `android:check ok (${javaFiles.filter((file) => file.startsWith(JAVA)).length} sources, `
    + `${javaFiles.length - javaFiles.filter((file) => file.startsWith(JAVA)).length} tests, `
    + `${declaredIds.size} layout ids)`,
);
for (const note of notes) console.log(`  · ${note}`);
