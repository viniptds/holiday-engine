#!/usr/bin/env node
// Generates docs/repo-map.md for holiday-engine: a compact, deterministic index of src/.
// Uses the `typescript` compiler API only (no other dependencies). Run: npm run repo-map
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'docs', 'repo-map.md');
const MAX_NAMES = 30; // longest list of bare names before "+N more"

/** One line per src/<module>/. Fallback for new modules: the module file's first doc-comment line. */
const MODULE_DESCRIPTIONS = {
  '(root)': 'Nest bootstrap (main.ts), AppModule wiring, health controller, HTTP server timeouts.',
  achievements: 'Achievements (unlocks, events), the trip Journey path and journey skips.',
  ai: 'AI trip planner: conversations/messages, itinerary and trip places, LLM providers (llm/), places directory (places/).',
  'app-common': 'Shared app-API pieces: AppError and reasons, exception filter, validation pipe, locale, timezone, rate window, LRU, APP_PREFIX.',
  'app-trips': 'App-side trips: membership checks, trip mapper, schedule hooks, TripMember entity.',
  auth: 'Google sign-in, JWT access/refresh tokens, AuthGuard, @CurrentUser, /me, dev login (dev only).',
  billing: 'RevenueCat webhook and sync, entitlements (Plus), AI quota, dev billing.',
  checklist: 'Per-trip checklist items, reminders, ordering and AI suggestions.',
  database: 'TypeORM/Postgres config and the migrations (listed in index order below).',
  events: 'Bot-side suggested events near a trip (providers, service).',
  idempotency: 'Idempotency-Key interceptor and stored keys for offline-safe writes.',
  mail: 'Transactional email: transport drivers, templates, config, redaction.',
  media: 'City and place photos (PhotoSource, destination resolver).',
  members: 'Trip members, invites (links, mailer), removals.',
  messages: 'Telegram bot inbound messages: controller, BullMQ queue/processor, router.',
  moments: 'Moments (photo uploads, presigned storage), avatar uploads, local file serving, ObjectStorage drivers.',
  notifications: 'Notifications inbox, push (Expo/log), scheduler, countdowns, unsubscribe tokens.',
  outbound: 'Outbound queue publisher towards the bot.',
  suggestions: 'Cron scheduler that triggers event suggestions.',
  testing: 'Shared test helpers (in-memory DB, app bootstrap, wizard questions).',
  trips: 'Bot-side Trip entity, DTOs and trip service.',
  users: 'User entity, UsersService/directory, deletion hooks, /me extensions, timezone interceptor.',
  wizard: 'Trip-creation wizard: question set loader, persona, localization.',
};

const KIND_BY_SUFFIX = [
  ['Controller', 'Controller'], ['Service', 'Service'], ['Module', 'Module'], ['Guard', 'Guard'],
  ['Interceptor', 'Interceptor'], ['Filter', 'Filter'], ['Pipe', 'Pipe'], ['Processor', 'Processor'],
  ['Scheduler', 'Scheduler'], ['Publisher', 'Publisher'], ['Provider', 'Provider'], ['Driver', 'Driver'],
  ['Mapper', 'Mapper'], ['Verifier', 'Verifier'], ['Router', 'Router'], ['Error', 'Error'],
  ['Exception', 'Error'], ['Storage', 'Storage'], ['Directory', 'Directory'], ['Source', 'Source'],
  ['Resolver', 'Resolver'], ['Mailer', 'Mailer'], ['Loader', 'Loader'], ['Hooks', 'Hooks'],
];
const ROUTE_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'Head', 'Options']);
const isTestFile = (f) => /\.(spec|test|e2e-spec)\.tsx?$/.test(f) || f.endsWith('.d.ts');
const isHelperPath = (rel) => /(^|\/)(testing|mocks)\//.test(rel);
const isEnvName = (s) => /^[A-Z][A-Z0-9_]{2,}$/.test(s);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !isTestFile(e.name)) out.push(p);
  }
  return out.sort();
}

const files = walk(SRC).map((abs) => {
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
  return { abs, rel, sf };
});

// ---- constant resolution (top-level string consts, e.g. APP_PREFIX) ----
const consts = new Map();
function evalStr(n) {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n)) return evalStr(n.expression);
  if (ts.isIdentifier(n)) return consts.has(n.text) ? consts.get(n.text) : `\${${n.text}}`;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = evalStr(n.left), b = evalStr(n.right);
    return a == null || b == null ? null : a + b;
  }
  if (ts.isTemplateExpression(n)) {
    let s = n.head.text;
    for (const sp of n.templateSpans) {
      const v = evalStr(sp.expression);
      s += (v ?? '${?}') + sp.literal.text;
    }
    return s;
  }
  return null;
}
for (const pass of [0, 1, 2]) {
  for (const { sf } of files) {
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer || consts.has(d.name.text)) continue;
        const v = evalStr(d.initializer);
        if (v != null && !v.includes('${')) consts.set(d.name.text, v);
      }
    }
  }
}

const hasExport = (n) => ts.getModifiers?.(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const decoratorsOf = (n) => (ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []);
function decoratorInfo(d) {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return { name: e.expression.text, args: e.arguments };
  if (ts.isIdentifier(e)) return { name: e.text, args: [] };
  return { name: '?', args: [] };
}
const joinPath = (...parts) => '/' + parts.map((p) => (p ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

function classKind(name, decos) {
  for (const k of ['Controller', 'Entity', 'Module']) if (decos.some((d) => d.name === k)) return k;
  for (const [suffix, kind] of KIND_BY_SUFFIX) if (name.endsWith(suffix)) return kind;
  if (/(Dto|Request|Response|Body|Query|Params)$/.test(name)) return 'Dto';
  if (decos.some((d) => d.name === 'Injectable')) return 'Injectable';
  return 'Class';
}

function entityTable(decorator, className) {
  const a = decorator.args[0];
  if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
  if (a && ts.isObjectLiteralExpression(a)) {
    for (const p of a.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === 'name') return evalStr(p.initializer) ?? '?';
    }
  }
  return `${className} (default name)`;
}

// ---- per-file extraction ----
const modules = new Map(); // module -> { files: [{rel, classes, fns, types, consts}] }
const envUses = new Map(); // ENV -> Set(file)
const addEnv = (name, rel) => {
  if (!isEnvName(name)) return;
  if (!envUses.has(name)) envUses.set(name, new Set());
  envUses.get(name).add(rel);
};

for (const { rel, sf } of files) {
  const mod = rel.includes('/') ? rel.split('/')[0] : '(root)';
  const info = { rel, classes: [], fns: [], types: [], consts: [] };
  if (!modules.has(mod)) modules.set(mod, { files: [] });
  modules.get(mod).files.push(info);

  for (const st of sf.statements) {
    if (!hasExport(st)) continue;
    if (ts.isClassDeclaration(st) && st.name) {
      const decos = decoratorsOf(st).map(decoratorInfo);
      const cls = { name: st.name.text, kind: classKind(st.name.text, decos), routes: [], table: null };
      const ctrl = decos.find((d) => d.name === 'Controller');
      if (ctrl) {
        const arg = ctrl.args[0];
        let prefix = '';
        if (arg) {
          const first = ts.isArrayLiteralExpression(arg) ? arg.elements[0] : ts.isObjectLiteralExpression(arg) ? arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'path')?.initializer : arg;
          prefix = evalStr(first) ?? '';
        }
        for (const m of st.members) {
          if (!ts.isMethodDeclaration(m)) continue;
          for (const d of decoratorsOf(m).map(decoratorInfo)) {
            if (!ROUTE_DECORATORS.has(d.name)) continue;
            const sub = d.args[0] ? evalStr(d.args[0]) ?? '' : '';
            cls.routes.push(`${d.name.toUpperCase()} ${joinPath(prefix, sub)} → ${m.name.getText()}`);
          }
        }
      }
      const ent = decos.find((d) => d.name === 'Entity');
      if (ent) cls.table = entityTable(ent, st.name.text);
      info.classes.push(cls);
    } else if (ts.isFunctionDeclaration(st) && st.name) info.fns.push(st.name.text);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
        (fn ? info.fns : info.consts).push(d.name.text);
      }
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) info.types.push(st.name.text);
  }

  // env variables: config.get('X'), process.env.X, helper(…, 'X'), *KEYS arrays, `required: [...]`
  const text = sf.getFullText();
  const dynamicGet = /\.(get|getOrThrow)(<[^>]*>)?\(\s*[a-z]\w*\s*[,)]/.test(text);
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n) && n.expression.getText() === 'process.env') addEnv(n.name.text, rel);
    if (ts.isElementAccessExpression(n) && n.expression.getText() === 'process.env' && ts.isStringLiteralLike(n.argumentExpression)) addEnv(n.argumentExpression.text, rel);
    if (ts.isCallExpression(n)) {
      const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : ts.isIdentifier(n.expression) ? n.expression.text : '';
      if (/^(get|getOrThrow|value|setting|read|env|readEnv)$/.test(callee)) for (const a of n.arguments) if (ts.isStringLiteralLike(a)) addEnv(a.text, rel);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && dynamicGet && /KEYS$/.test(n.name.text) && n.initializer) {
      const arr = ts.isAsExpression(n.initializer) ? n.initializer.expression : n.initializer;
      if (ts.isArrayLiteralExpression(arr)) for (const e of arr.elements) if (ts.isStringLiteralLike(e)) addEnv(e.text, rel);
    }
    if (ts.isPropertyAssignment(n) && n.name.getText() === 'required' && ts.isArrayLiteralExpression(n.initializer)) {
      for (const e of n.initializer.elements) if (ts.isStringLiteralLike(e)) addEnv(e.text, rel);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---- rendering ----
const cap = (names) => {
  const u = [...new Set(names)].sort();
  return u.length > MAX_NAMES ? `${u.slice(0, MAX_NAMES).join(', ')}, +${u.length - MAX_NAMES} more` : u.join(', ');
};
const bt = (s) => `\`${s}\``;

function moduleDescription(mod) {
  if (MODULE_DESCRIPTIONS[mod]) return MODULE_DESCRIPTIONS[mod];
  const f = files.find((x) => x.rel.startsWith(`${mod}/`) && x.rel.endsWith('.module.ts'));
  const m = f && /\/\*\*\s*([^\n*]+)/.exec(f.sf.getFullText());
  return m ? m[1].trim() : '(no description: add one to MODULE_DESCRIPTIONS in scripts/repo-map.mjs)';
}

const out = [];
out.push('# Repo map: holiday-engine', '');
out.push('Generated by scripts/repo-map.mjs, do not edit by hand. Regenerate with `npm run repo-map`.', '');
out.push(
  'Legend: one section per `src/<module>/` (files are relative to it; the module header line says what it is). ' +
    '`Kind Name file` is an exported class with its kind (Controller, Service, Entity, Module, Guard, ...). ' +
    'Controller routes are indented below it as `METHOD /full/path → handler` (@Controller prefix plus method decorator; constants such as ' +
    'APP_PREFIX are resolved). Entities show their table name. `Dtos` collapses validation/request classes. `fns`, `types` and `consts` ' +
    'list exported names only (long lists are cut with "+N more"); `test helpers` are names from testing/ folders. Spec files are not scanned. ' +
    'Migrations and env variables follow the modules.',
  ''
);

const moduleNames = [...modules.keys()].sort((a, b) => (a === '(root)' ? -1 : b === '(root)' ? 1 : a.localeCompare(b)));
for (const mod of moduleNames) {
  out.push(`## ${mod === '(root)' ? 'src/ (root files)' : `src/${mod}/`}`, moduleDescription(mod), '');
  const classLines = [];
  const dtos = [];
  const fns = [], types = [], cs = [], helpers = [];
  for (const f of modules.get(mod).files) {
    const local = mod === '(root)' ? f.rel : f.rel.slice(mod.length + 1);
    if (isHelperPath(f.rel) || (mod === 'testing')) {
      helpers.push(...f.classes.map((c) => c.name), ...f.fns, ...f.consts);
      continue;
    }
    if (f.rel.startsWith('database/migrations/')) continue;
    for (const c of f.classes) {
      if (c.kind === 'Dto') dtos.push({ name: c.name, file: local });
      else {
        classLines.push(`- ${c.kind} ${c.name} ${bt(local)}${c.table ? ` · table ${bt(c.table)}` : ''}`);
        for (const r of c.routes) classLines.push(`  - ${r}`);
      }
    }
    fns.push(...f.fns);
    types.push(...f.types);
    cs.push(...f.consts);
  }
  out.push(...classLines);
  if (dtos.length) {
    const dirs = [...new Set(dtos.map((d) => d.file))].sort();
    out.push(`- Dtos (${dtos.length}): ${cap(dtos.map((d) => d.name))} · in ${dirs.length > 4 ? `${dirs.length} files (${dirs.slice(0, 4).join(', ')}, ...)` : dirs.join(', ')}`);
  }
  if (fns.length) out.push(`- fns: ${cap(fns)}`);
  if (types.length) out.push(`- types: ${cap(types)}`);
  if (cs.length) out.push(`- consts: ${cap(cs)}`);
  if (helpers.length) out.push(`- test helpers: ${cap(helpers)}`);
  out.push('');
}

// migrations in registration order (src/database/migrations/index.ts)
const migDir = 'database/migrations/';
const migFiles = files.filter((f) => f.rel.startsWith(migDir) && f.rel !== `${migDir}index.ts`);
const indexFile = files.find((f) => f.rel === `${migDir}index.ts`);
const classToFile = new Map();
const order = [];
if (indexFile) {
  for (const st of indexFile.sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) classToFile.set(el.name.text, st.moduleSpecifier.text.replace(/^\.\//, '').replace(/\.js$/, '.ts'));
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (d.name.getText() === 'migrations' && d.initializer && ts.isArrayLiteralExpression(d.initializer)) for (const e of d.initializer.elements) order.push(e.getText());
      }
    }
  }
}
out.push('## Migrations (index order)', `Registered in ${bt('src/database/migrations/index.ts')} (a new migration must be added there). Files are in that directory.`, '');
order.forEach((cls, i) => out.push(`${i + 1}. ${cls} · ${bt(classToFile.get(cls) ?? '?')}`));
const registered = new Set(order.map((c) => classToFile.get(c)));
for (const f of migFiles) if (!registered.has(path.basename(f.rel))) out.push(`- NOT REGISTERED in index.ts: ${bt(path.basename(f.rel))}`);
out.push('');

out.push('## Env variables read', 'Found via `config.get(...)`, `process.env.X`, env key lists and similar readers. Name · files.', '');
for (const name of [...envUses.keys()].sort()) {
  const fs_ = [...envUses.get(name)].sort();
  out.push(`- ${name} · ${fs_.length > 3 ? `${fs_.slice(0, 3).join(', ')}, +${fs_.length - 3}` : fs_.join(', ')}`);
}
out.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
console.log(`wrote ${path.relative(ROOT, OUT)} (${out.length} lines)`);
