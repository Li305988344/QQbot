// Pin the active persona in each bridge, and optionally turn random rotation off.
//
// Why a script instead of the console API: /api/role needs the console access token,
// and the state file is the single source of truth anyway (readRoleState() re-reads it
// from disk on every call, so no in-process cache has to be poked).
//
// Role names are written as \u escapes so this file stays pure ASCII — PowerShell/cmd
// mangles non-ASCII command lines on this box, and keeping the source ASCII removes the
// whole class of encoding surprises.
//
//   node ops/pin-role.mjs <roleName> [--random | --no-random]
//   node ops/pin-role.mjs --b1=<role> --b2=<role> [--random | --no-random]
//
// No args => pin SHANA (\u590f\u5a1c) with random off.
//
// --b1=<role>  pin only bridge-01 to <role> (the other bridge inherits the positional
// --b2=<role>  role, or keeps its current persona if none was given)
//
// --random     explicitly turn random rotation ON (start from this role, then rotate)
// --no-random  explicitly turn it off (same as the default)
// Omitting both keeps whatever the current state already is -- so re-pinning a role
// does not silently flip the rotation mode the user chose earlier.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:\\QQbot';
const BRIDGES = ['qq-bridge-01', 'qq-bridge-02'];
const DEFAULT_ROLE = '\u590f\u5a1c'; // \u590f\u5a1c = Shana

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const wantRandom = argv.includes('--random');
const wantNoRandom = argv.includes('--no-random');
if (wantRandom && wantNoRandom) {
  console.log('--random and --no-random are mutually exclusive');
  process.exit(1);
}

/**
 * Decode `\uXXXX` escapes typed on the command line.
 *
 * This box cannot pass non-ASCII through PowerShell 5.1 + cmd reliably (the bytes get
 * reinterpreted under the active code page, so a Chinese role name arrives as mojibake
 * and the script then reports "role card missing"). Keeping the command line pure ASCII
 * and writing the name as \u escapes sidesteps the whole problem:
 *
 *   --b1=\u59d0\u59d0   ->  姐姐
 */
function decodeEscapes(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Read a --b1=xxx / --b2=xxx flag, returning null when absent. */
function perBridge(index) {
  const flag = `--b${index}=`;
  const hit = argv.find((a) => a.startsWith(flag));
  return hit ? decodeEscapes(hit.slice(flag.length).trim()) : null;
}

const fallback = positional[0] ? decodeEscapes(positional[0]) : null;
const targets = BRIDGES.map((name, i) => {
  const explicit = perBridge(i + 1);
  return { name, role: explicit || fallback || DEFAULT_ROLE };
});

let failed = 0;

for (const { name, role: target } of targets) {
  const dir = path.join(ROOT, name);
  const stateFile = path.join(dir, 'state', 'current-role.json');
  const roleFile = path.join(dir, 'roles', `${target}.md`);

  if (!fs.existsSync(dir)) {
    console.log(`[skip] ${name}: no such bridge folder`);
    failed++;
    continue;
  }
  if (!fs.existsSync(roleFile)) {
    console.log(`[fail] ${name}: role card missing -> ${path.join('roles', target + '.md')}`);
    failed++;
    continue;
  }

  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    console.log(`[warn] ${name}: state unreadable (${e.code || e.message}), starting fresh`);
  }

  const next = {
    ...(prev || {}),
    role: target,
    mode: 'active',
    // Explicit flags win; otherwise inherit the current value so pinning a role does not
    // quietly change how rotation behaves.
    random: wantRandom ? true : wantNoRandom ? false : Boolean(prev?.random),
    turns: 0,
  };

  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, stateFile);

  // Read it back — never trust the write, the whole point is the bridge agrees.
  const check = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const ok = check.role === target && check.random === next.random && check.mode === 'active';
  console.log(`${ok ? '[ok]' : '[MISMATCH]'} ${name}: role=${JSON.stringify(check.role)} mode=${check.mode} random=${check.random} turns=${check.turns}`);
  if (!ok) failed++;
}

console.log(failed === 0 ? 'RESULT: all bridges pinned' : `RESULT: ${failed} bridge(s) failed`);
process.exit(failed === 0 ? 0 : 1);
