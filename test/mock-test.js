// Simulated Figma test for Ghost Variable Cleaner
// ---------------------------------------------------------------------------
// A Figma plugin can only really run inside Figma, so this file builds a small
// fake Figma in memory, loads code.js into it, and checks what the plugin does.
//
// Run it with:   node test/mock-test.js code.js
//
// The fake file contains:
//   - one local variable and one healthy library variable    (must be ignored)
//   - "DS v1": a library that is no longer enabled, with
//       color/accent  -> should reconnect to color/accent in "DS v2"
//       space/md      -> should reconnect to space/md in "DS v2"
//       legacy/old    -> no replacement, can only be detached
//   - a variable that was deleted outright                    (missing)
//   - frames set to a "DS v1" mode, and to a deleted collection's mode
//   - bindings on fills, strokes, effects, a gradient stop, padding and text,
//     spread over two pages
// ---------------------------------------------------------------------------

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var codePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'code.js'));
var source = fs.readFileSync(codePath, 'utf8');

var failures = 0;
function check(label, ok, detail) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + (ok || detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

function alias(id) { return { type: 'VARIABLE_ALIAS', id: id }; }
function solid(r, g, b, varId) {
  var p = { type: 'SOLID', color: { r: r, g: g, b: b }, opacity: 1 };
  if (varId) p.boundVariables = { color: alias(varId) };
  return p;
}
function clone(x) { return JSON.parse(JSON.stringify(x)); }

function buildWorld(opts) {
  opts = opts || {};

  // ---- variables and collections --------------------------------------------
  var collections = new Map();
  var variables = new Map();
  function addCollection(c) { collections.set(c.id, c); return c; }
  function addVariable(v) { variables.set(v.id, v); return v; }

  addCollection({ id: 'C:local', name: 'Local', remote: false, key: 'k-local', modes: [{ modeId: 'l-1', name: 'Default' }] });
  addVariable({ id: 'V:local', name: 'color/brand', resolvedType: 'COLOR', remote: false, variableCollectionId: 'C:local', key: 'kv-local' });

  // DS v2: enabled. Only color/primary has been imported into the file so far.
  addCollection({ id: 'C:v2', name: 'Tokens', remote: true, key: 'K2', modes: [{ modeId: 'v2-light', name: 'Light' }, { modeId: 'v2-dark', name: 'Dark' }] });
  addVariable({ id: 'V:v2-primary', name: 'color/primary', resolvedType: 'COLOR', remote: true, variableCollectionId: 'C:v2', key: 'kv2-primary' });

  // DS v1: still known to the file, but the library is no longer enabled.
  addCollection({ id: 'C:v1', name: 'Tokens', remote: true, key: 'K1', modes: [{ modeId: 'v1-light', name: 'Light' }, { modeId: 'v1-dark', name: 'Dark' }] });
  addVariable({ id: 'V:v1-accent', name: 'color/accent', resolvedType: 'COLOR', remote: true, variableCollectionId: 'C:v1', key: 'kv1-accent' });
  addVariable({ id: 'V:v1-space', name: 'space/md', resolvedType: 'FLOAT', remote: true, variableCollectionId: 'C:v1', key: 'kv1-space' });
  addVariable({ id: 'V:v1-old', name: 'legacy/old', resolvedType: 'COLOR', remote: true, variableCollectionId: 'C:v1', key: 'kv1-old' });

  var library = {
    collections: [{ key: 'K2', name: 'Tokens', libraryName: 'DS v2' }],
    vars: {
      K2: [
        { key: 'kv2-primary', name: 'color/primary', resolvedType: 'COLOR' },
        { key: 'kv2-accent', name: 'color/accent', resolvedType: 'COLOR' },
        { key: 'kv2-space', name: 'space/md', resolvedType: 'FLOAT' }
      ]
    },
    // What importing each key creates in the file.
    importable: {
      'kv2-primary': 'V:v2-primary',
      'kv2-accent': { id: 'V:v2-accent', name: 'color/accent', resolvedType: 'COLOR', remote: true, variableCollectionId: 'C:v2', key: 'kv2-accent' },
      'kv2-space': { id: 'V:v2-space', name: 'space/md', resolvedType: 'FLOAT', remote: true, variableCollectionId: 'C:v2', key: 'kv2-space' }
    }
  };
  var imports = [];

  // ---- layers ---------------------------------------------------------------
  var nodes = new Map();
  function node(props) {
    var n = Object.assign({ removed: false, boundVariables: {} }, props);
    n.setBoundVariable = function (field, v) {
      var bv = Object.assign({}, n.boundVariables);
      if (v) bv[field] = alias(v.id); else delete bv[field];
      n.boundVariables = bv;
    };
    n.setExplicitVariableModeForCollection = function (col, modeId) {
      var m = Object.assign({}, n.explicitVariableModes);
      m[typeof col === 'string' ? col : col.id] = modeId;
      n.explicitVariableModes = m;
    };
    n.clearExplicitVariableModeForCollection = function (col) {
      var m = Object.assign({}, n.explicitVariableModes);
      delete m[typeof col === 'string' ? col : col.id];
      n.explicitVariableModes = m;
    };
    nodes.set(n.id, n);
    return n;
  }

  // A text layer, stored as styled segments.
  function textNode(props) {
    var n = node(Object.assign({ type: 'TEXT' }, props));
    n.getStyledTextSegments = function () { return clone(n.segments); };
    n.getRangeAllFontNames = function () { return [{ family: 'Inter', style: 'Regular' }]; };
    function seg(start, end) {
      var s = n.segments.find(function (x) { return x.start === start && x.end === end; });
      if (!s) throw new Error('Mock only supports whole segments');
      return s;
    }
    n.getRangeFills = function (start, end) { return clone(seg(start, end).fills); };
    n.setRangeFills = function (start, end, fills) {
      if (!world.fontsLoaded) throw new Error('Font not loaded');
      seg(start, end).fills = clone(fills);
    };
    n.setRangeBoundVariable = function (start, end, field, v) {
      if (!world.fontsLoaded) throw new Error('Font not loaded');
      var s = seg(start, end);
      if (v) s.boundVariables[field] = alias(v.id); else delete s.boundVariables[field];
    };
    return n;
  }

  var frame = node({
    id: '1:1', name: 'Card', type: 'FRAME',
    fills: [solid(1, 0, 0, 'V:v1-accent')],
    strokes: [solid(0, 0, 1, 'V:local')],
    effects: [], layoutGrids: [],
    boundVariables: { paddingLeft: alias('V:v1-space') },
    explicitVariableModes: { 'C:v1': 'v1-dark', 'C:gone': 'gone-1' }
  });
  var rect = node({
    id: '1:2', name: 'Dead fill', type: 'RECTANGLE',
    fills: [solid(0, 1, 0, 'V:deleted')], strokes: [],
    effects: [{ type: 'DROP_SHADOW', radius: 4, boundVariables: { radius: alias('V:v1-old') } }],
    layoutGrids: []
  });
  var gradient = node({
    id: '1:3', name: 'Gradient', type: 'RECTANGLE',
    fills: [{
      type: 'GRADIENT_LINEAR', opacity: 1,
      gradientStops: [
        { position: 0, color: { r: 1, g: 1, b: 0, a: 1 }, boundVariables: { color: alias('V:v1-old') } },
        { position: 1, color: { r: 0, g: 0, b: 1, a: 1 }, boundVariables: { color: alias('V:v2-primary') } }
      ]
    }],
    strokes: [], effects: [], layoutGrids: []
  });
  var text = textNode({
    id: '1:4', name: 'Title', characters: 'Hello world',
    segments: [
      { start: 0, end: 5, boundVariables: {}, fills: [solid(1, 0, 0, 'V:v1-accent')] },
      { start: 5, end: 11, boundVariables: {}, fills: [solid(0, 0, 0)] }
    ],
    strokes: [], effects: [], layoutGrids: []
  });
  frame.children = [rect, gradient, text];

  var other = node({
    id: '2:1', name: 'Other page rect', type: 'RECTANGLE',
    fills: [solid(1, 0, 0, 'V:v1-accent')], strokes: [], effects: [], layoutGrids: []
  });

  var page1 = node({ id: '0:1', name: 'Page 1', type: 'PAGE', children: [frame], selection: [] });
  var page2 = node({ id: '0:2', name: 'Page 2', type: 'PAGE', children: [other], selection: [] });

  // ---- the figma global -----------------------------------------------------
  var world = {
    messages: [], notifications: [], undoCommits: 0, fontsLoaded: false,
    nodes: nodes, variables: variables, collections: collections, imports: imports
  };

  function setForPaint(paint, field, v) {
    var p = clone(paint);
    var bv = Object.assign({}, p.boundVariables);
    if (v) bv[field] = alias(v.id); else delete bv[field];
    p.boundVariables = bv;
    return p;
  }
  function setForEffectOrGrid(obj, field, v) { return setForPaint(obj, field, v); }

  var figma = {
    root: { children: [page1, page2] },
    currentPage: page1,
    showUI: function () {},
    ui: { postMessage: function (m) { world.messages.push(clone(m)); }, onmessage: null },
    notify: function (t) { world.notifications.push(t); },
    commitUndo: function () { world.undoCommits++; },
    closePlugin: function () {},
    loadAllPagesAsync: async function () {},
    loadFontAsync: async function () { world.fontsLoaded = true; },
    getNodeByIdAsync: async function (id) { return nodes.get(id) || null; },
    setCurrentPageAsync: async function (p) { figma.currentPage = p; },
    viewport: { scrollAndZoomIntoView: function () {} },
    variables: {
      getVariableByIdAsync: async function (id) { return variables.get(id) || null; },
      getVariableCollectionByIdAsync: async function (id) { return collections.get(id) || null; },
      getLocalVariablesAsync: async function () {
        return Array.from(variables.values()).filter(function (v) { return !v.remote; });
      },
      getLocalVariableCollectionsAsync: async function () {
        return Array.from(collections.values()).filter(function (c) { return !c.remote; });
      },
      importVariableByKeyAsync: async function (key) {
        imports.push(key);
        var spec = library.importable[key];
        if (!spec) throw new Error('No such key ' + key);
        if (typeof spec === 'string') return variables.get(spec);
        if (!variables.has(spec.id)) addVariable(Object.assign({}, spec));
        return variables.get(spec.id);
      },
      createVariableAlias: function (v) { return alias(v.id); },
      setBoundVariableForPaint: setForPaint,
      setBoundVariableForEffect: setForEffectOrGrid,
      setBoundVariableForLayoutGrid: setForEffectOrGrid
    },
    teamLibrary: {
      getAvailableLibraryVariableCollectionsAsync: async function () {
        if (opts.noLibraryAccess) throw new Error('No team library access');
        return library.collections.slice();
      },
      getVariablesInLibraryCollectionAsync: async function (key) {
        if (opts.noLibraryAccess) throw new Error('No team library access');
        return (library.vars[key] || []).slice();
      }
    }
  };

  vm.runInNewContext(source, {
    figma: figma, __html__: '', console: console,
    setTimeout: setTimeout, Promise: Promise, Map: Map, Set: Set
  });

  world.figma = figma;
  world.send = async function (msg) { await figma.ui.onmessage(msg); };
  world.lastOf = function (type) {
    for (var i = world.messages.length - 1; i >= 0; i--) if (world.messages[i].type === type) return world.messages[i];
    return null;
  };
  return world;
}

function byName(results) {
  var out = {};
  results.groups.forEach(function (g) { out[g.name] = g; });
  return out;
}

(async function main() {
  // -------------------------------------------------------------------------
  console.log('\n1. Scanning all pages finds every ghost and nothing healthy');
  var w = buildWorld();
  await w.send({ type: 'scan', scope: 'document' });
  var r = w.lastOf('results');
  var g = byName(r);
  var names = Object.keys(g).sort();
  check('finds exactly 6 ghosts', r.groups.length === 6, names);
  check('deleted variable is "missing"', g['Deleted variable'] && g['Deleted variable'].status === 'missing');
  check('color/accent is "orphaned" on 3 layers over 2 pages',
    g['color/accent'] && g['color/accent'].status === 'orphaned' && g['color/accent'].layers === 3 && g['color/accent'].pages === 2,
    g['color/accent']);
  check('legacy/old found on the shadow and the gradient stop',
    g['legacy/old'] && g['legacy/old'].bindings === 2, g['legacy/old']);
  check('space/md found on padding', g['space/md'] && g['space/md'].bindings === 1);
  check('DS v1 mode is "orphaned"', g['Variable mode: Tokens'] && g['Variable mode: Tokens'].status === 'orphaned');
  check('deleted collection mode is "missing"', g['Variable mode: Deleted collection'] && g['Variable mode: Deleted collection'].status === 'missing');
  check('healthy: 1 local and 1 library variable', r.healthy.local === 1 && r.healthy.library === 1, r.healthy);
  check('scan changes nothing', w.undoCommits === 0 && w.imports.length === 0, { undo: w.undoCommits, imports: w.imports });

  console.log('\n2. Scan suggests same-named replacements');
  check('color/accent → color/accent in DS v2',
    g['color/accent'].match && g['color/accent'].match.library === 'DS v2' && g['color/accent'].match.name === 'color/accent', g['color/accent'].match);
  check('space/md → space/md in DS v2', g['space/md'].match && g['space/md'].match.library === 'DS v2');
  check('DS v1 mode → Tokens in DS v2', g['Variable mode: Tokens'].match && g['Variable mode: Tokens'].match.library === 'DS v2');
  check('legacy/old has no match', g['legacy/old'].match === null);
  check('deleted variable and collection have no match',
    !g['Deleted variable'].match && !g['Variable mode: Deleted collection'].match);

  // -------------------------------------------------------------------------
  console.log('\n3. Reconnect rebinds matched ghosts and leaves the rest alone');
  await w.send({ type: 'reconnect', keys: r.groups.map(function (x) { return x.key; }) });
  var cleaned = w.lastOf('cleaned');
  check('reconnected 5 bindings (3 accent + 1 space + 1 mode), 0 failures',
    cleaned.action === 'reconnect' && cleaned.done === 5 && cleaned.failed === 0, cleaned);
  var frame = w.nodes.get('1:1');
  check('frame fill now uses DS v2 color/accent', frame.fills[0].boundVariables.color.id === 'V:v2-accent', frame.fills[0]);
  check('text range fill now uses DS v2 color/accent', w.nodes.get('1:4').segments[0].fills[0].boundVariables.color.id === 'V:v2-accent');
  check('other page rect now uses DS v2 color/accent', w.nodes.get('2:1').fills[0].boundVariables.color.id === 'V:v2-accent');
  check('padding now uses DS v2 space/md', frame.boundVariables.paddingLeft.id === 'V:v2-space');
  check('frame mode switched from DS v1 "Dark" to DS v2 "Dark"',
    frame.explicitVariableModes['C:v2'] === 'v2-dark' && !('C:v1' in frame.explicitVariableModes), frame.explicitVariableModes);
  check('deleted-collection mode left for detach', frame.explicitVariableModes['C:gone'] === 'gone-1');
  check('local stroke untouched', frame.strokes[0].boundVariables.color.id === 'V:local');
  check('unmatched shadow binding untouched', w.nodes.get('1:2').effects[0].boundVariables.radius.id === 'V:v1-old');
  check('one undo step', w.undoCommits === 1, w.undoCommits);
  var r2 = w.lastOf('results');
  check('re-scan shows the 3 ghosts that had no match', r2.groups.length === 3, r2.groups.map(function (x) { return x.name; }));
  check('re-scan counts the new library variables as healthy', r2.healthy.library === 3, r2.healthy);

  // -------------------------------------------------------------------------
  console.log('\n4. Detach removes what is left and keeps how things look');
  await w.send({ type: 'clean', keys: r2.groups.map(function (x) { return x.key; }) });
  cleaned = w.lastOf('cleaned');
  check('detached 4 bindings (deleted fill, shadow, gradient stop, dead mode), 0 failures',
    cleaned.action === 'detach' && cleaned.done === 4 && cleaned.failed === 0, cleaned);
  var rect = w.nodes.get('1:2');
  check('deleted-variable fill unbound, colour kept',
    !rect.fills[0].boundVariables.color && rect.fills[0].color.g === 1, rect.fills[0]);
  check('shadow radius unbound, value kept', !rect.effects[0].boundVariables.radius && rect.effects[0].radius === 4);
  var stops = w.nodes.get('1:3').fills[0].gradientStops;
  check('ghost gradient stop unbound, colour kept', !stops[0].boundVariables && stops[0].color.r === 1, stops[0]);
  check('healthy gradient stop still bound', stops[1].boundVariables.color.id === 'V:v2-primary');
  check('dead mode cleared', !('C:gone' in frame.explicitVariableModes));
  check('DS v2 mode kept', frame.explicitVariableModes['C:v2'] === 'v2-dark');
  check('one more undo step', w.undoCommits === 2);
  check('final scan finds no ghosts', w.lastOf('results').groups.length === 0, w.lastOf('results').groups);

  // -------------------------------------------------------------------------
  console.log('\n5. Detach-only on a fresh file still works for matched ghosts');
  w = buildWorld();
  await w.send({ type: 'scan', scope: 'page' });
  r = w.lastOf('results');
  check('page scope sees 2 of the 3 color/accent layers', byName(r)['color/accent'].layers === 2);
  await w.send({ type: 'clean', keys: r.groups.map(function (x) { return x.key; }) });
  cleaned = w.lastOf('cleaned');
  check('detached all 8 ghost bindings on this page, 0 failures', cleaned.done === 8 && cleaned.failed === 0, cleaned);
  check('frame keeps its red fill', w.nodes.get('1:1').fills[0].color.r === 1 && !w.nodes.get('1:1').fills[0].boundVariables.color);
  check('nothing was imported', w.imports.length === 0, w.imports);

  // -------------------------------------------------------------------------
  console.log('\n6. Without library access, library variables are "Check library"');
  w = buildWorld({ noLibraryAccess: true });
  await w.send({ type: 'scan', scope: 'document' });
  r = w.lastOf('results');
  g = byName(r);
  check('librariesChecked is false', r.librariesChecked === false);
  check('DS v1 and DS v2 variables marked "unknown"',
    g['color/accent'].status === 'unknown' && g['color/primary'] && g['color/primary'].status === 'unknown');
  check('no library matches suggested', r.groups.every(function (x) { return !x.match || x.match.library === 'This file'; }));

  // -------------------------------------------------------------------------
  console.log('\n7. Selection scope with nothing selected asks for a selection');
  w = buildWorld();
  await w.send({ type: 'scan', scope: 'selection' });
  check('sends a friendly error', w.lastOf('error') && /Select some layers/.test(w.lastOf('error').text));

  console.log(failures ? '\n' + failures + ' check(s) FAILED\n' : '\nAll checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
