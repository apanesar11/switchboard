// SB.views.databases — saved workspace connections and a read-only record browser.
// A retained root per workspace keeps modal typing, table scroll and focus intact
// when the app paints a run state or terminal bell. Connection URIs only live in the
// add dialog; the bridge sends back metadata, never the saved credential.
window.SB = window.SB || {};
SB.views = SB.views || {};

(function (SB) {
  'use strict';

  var D = SB.dom;
  var h = D.h;
  var panes = new Map();
  var activeId = null;
  var ROW_HEIGHT = 44;
  var HEADER_HEIGHT = 48;
  var paths = {
    database: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2.5"/><path d="M2.5 3.5v9c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5v-9M2.5 8c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5"/>',
    chevron: '<path d="m5 6 3 3 3-3"/>',
    right: '<path d="m6 4 4 4-4 4"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    refresh: '<path d="M13.3 6a5.5 5.5 0 1 0 .1 3M13.5 2.5V6H10"/>',
    table: '<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M2 6h12M6 6v8"/>',
    close: '<path d="m4 4 8 8M12 4l-8 8"/>',
    check: '<path d="m3 8 3 3 7-7"/>',
    lock: '<rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
    document: '<path d="M4 1.5h5l3 3v10H4zM9 1.5v3h3M6 8h4M6 11h3"/>',
    trash: '<path d="M3 4h10M6 4V2h4v2M4 4l.5 10h7L12 4M6.5 6.5v5M9.5 6.5v5"/>'
  };

  function icon(name, cls) {
    // Only these fixed SVG paths use HTML; database text is always a text node.
    return h('span.db-icon' + (cls ? '.' + cls : ''), { html: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || '') + '</svg>', 'aria-hidden': 'true' });
  }

  function message(result, fallback) {
    var text = result && typeof result.error === 'string' ? result.error : '';
    return text || fallback || 'The database request did not finish. Try again.';
  }

  function call(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var api = window.sb;
    if (!api || typeof api[name] !== 'function') return Promise.resolve({ ok: false, error: 'Database connections are unavailable in this build.' });
    try {
      return Promise.resolve(api[name].apply(api, args)).then(function (result) {
        return result && typeof result === 'object' ? result : { ok: false };
      }, function () {
        // Raw bridge errors can contain request arguments, so they never reach UI.
        return { ok: false, error: 'The database request did not finish. Try again.' };
      });
    } catch (err) {
      return Promise.resolve({ ok: false, error: 'The database request did not finish. Try again.' });
    }
  }

  function onTab(route) {
    return !!route && route.view === 'workspace' && route.tab === 'databases' && !!route.wsId && String(route.wsId).charAt(0) !== '/';
  }

  function providerLabel(provider) { return provider === 'mongodb' ? 'MongoDB' : 'Neon · PostgreSQL'; }
  function brand(provider) { return h('span.db-brand' + (provider === 'mongodb' ? '.mongo' : ''), null, provider === 'mongodb' ? 'M' : 'N'); }
  function current(pane) { return pane.connections.filter(function (c) { return c.id === pane.connectionId; })[0] || null; }
  function entity(pane) { return pane.entities.filter(function (e) { return e.id === pane.entityId; })[0] || null; }
  function live(pane) { return !pane.disposed && activeId === pane.wsId; }
  function btn(label, action, cls, attrs) {
    var options = Object.assign({ type: 'button', dataset: { dbAction: action }, 'data-db-focus': action }, attrs || {});
    var component = cls === 'close' ? 'db-close' : cls && cls.indexOf('provider-option') === 0 ? 'db-provider-option' : action === 'show-uri' ? 'db-show-uri' : 'db-btn';
    var modifiers = component === 'db-close' || component === 'db-show-uri' ? '' : component === 'db-provider-option' ? cls.replace('provider-option', '').trim() : cls || '';
    return h('button.' + component + (modifiers ? '.' + modifiers.replace(/ /g, '.') : ''), options, label);
  }
  function focus(pane, key) {
    var items = pane.root.querySelectorAll('[data-db-focus]');
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute('data-db-focus') !== key) continue;
      try { items[i].focus({ preventScroll: true }); } catch (err) { items[i].focus(); }
      return;
    }
  }
  function focusKey(pane) {
    var el = document.activeElement;
    return el && pane.root.contains(el) && el.getAttribute ? el.getAttribute('data-db-focus') : null;
  }
  function metadata(rows) {
    return (Array.isArray(rows) ? rows : []).filter(function (row) { return row && typeof row.id === 'string'; }).map(function (row) {
      return { id: row.id, name: String(row.name || 'Database'), provider: row.provider === 'mongodb' ? 'mongodb' : 'postgres', database: String(row.database || ''), host: String(row.host || ''), createdAt: row.createdAt };
    });
  }

  function build(wsId) {
    var pane = {
      wsId: wsId, disposed: false, connections: [], listLoaded: false, listLoading: false,
      connectionId: null, entities: [], entitiesLoading: false, entitiesLoaded: false,
      entityId: null, records: null, recordsLoading: false, selectedRow: null,
      listEpoch: 0, entityEpoch: 0, recordEpoch: 0, modalEpoch: 0,
      menu: '', error: '', errorKind: '', modal: null, tableScroll: null, tbody: null,
      scrollTop: 0, scrollLeft: 0, firstRow: -1, lastRow: -1, frame: null,
      returnFocus: null, hd: null
    };
    pane.content = h('div.db-content');
    pane.overlay = h('div.db-overlay');
    pane.body = h('div.bd.pane.db-body', null, pane.content, pane.overlay);
    pane.root = h('div.view.dbview', { style: 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:0' }, pane.body);
    pane.root.addEventListener('click', function (e) { click(pane, e); });
    pane.root.addEventListener('keydown', function (e) { localKey(pane, e); });
    pane.root.addEventListener('input', function (e) { if (pane.modal && pane.modal.form && pane.modal.form.contains(e.target)) validateForm(pane); });
    pane.root.addEventListener('submit', function (e) { if (pane.modal && e.target === pane.modal.form) { e.preventDefault(); addConnection(pane); } });
    panes.set(wsId, pane);
    return pane;
  }

  function invalidate(pane) {
    pane.entityEpoch++;
    pane.recordEpoch++;
    pane.entitiesLoading = false;
    pane.recordsLoading = false;
    // The full record result can be large. Keep only the chosen entity while this
    // pane is hidden, and fetch it afresh on return instead of caching every workspace.
    pane.records = null;
    pane.menu = '';
    pane.selectedRow = null;
    pane.tableScroll = null;
    pane.tbody = null;
    D.clear(pane.content);
    if (pane.frame !== null) { cancelAnimationFrame(pane.frame); pane.frame = null; }
    closeModal(pane, false);
  }

  function loadConnections(pane) {
    var epoch = ++pane.listEpoch;
    pane.listLoading = true;
    pane.error = '';
    pane.errorKind = '';
    paint(pane);
    return call('databaseList', pane.wsId).then(function (result) {
      if (pane.disposed || epoch !== pane.listEpoch) return;
      pane.listLoading = false;
      if (!result.ok) {
        pane.error = message(result, 'Could not load connections.');
        pane.errorKind = 'connections';
        paint(pane);
        return;
      }
      pane.connections = metadata(result.connections);
      pane.listLoaded = true;
      var chosen = current(pane);
      if (!chosen) {
        pane.connectionId = pane.connections[0] ? pane.connections[0].id : null;
        resetEntity(pane);
      }
      paint(pane);
      if (live(pane) && pane.connectionId && !pane.entitiesLoaded) loadEntities(pane);
      else if (live(pane) && pane.entityId && !pane.records && !pane.recordsLoading && pane.errorKind !== 'records') fetchRecords(pane, pane.entityId);
    });
  }

  function resetEntity(pane) {
    pane.entityEpoch++;
    pane.recordEpoch++;
    pane.entities = [];
    pane.entitiesLoading = false;
    pane.entitiesLoaded = false;
    pane.entityId = null;
    pane.records = null;
    pane.recordsLoading = false;
    pane.selectedRow = null;
    pane.scrollTop = 0;
    pane.scrollLeft = 0;
  }

  function selectConnection(pane, id) {
    if (pane.connectionId === id) { pane.menu = ''; paint(pane); focus(pane, 'connection-picker'); return; }
    pane.connectionId = id;
    pane.menu = '';
    pane.error = '';
    resetEntity(pane);
    paint(pane);
    focus(pane, 'connection-picker');
    loadEntities(pane);
  }

  function loadEntities(pane) {
    var connectionId = pane.connectionId;
    if (!connectionId) return Promise.resolve();
    var epoch = ++pane.entityEpoch;
    pane.entitiesLoading = true;
    pane.error = '';
    pane.errorKind = '';
    paint(pane);
    return call('databaseEntities', pane.wsId, connectionId).then(function (result) {
      if (!live(pane) || epoch !== pane.entityEpoch || connectionId !== pane.connectionId) return;
      pane.entitiesLoading = false;
      if (!result.ok) {
        pane.error = message(result, 'Could not load entities.');
        pane.errorKind = 'entities';
      } else {
        pane.entities = (Array.isArray(result.entities) ? result.entities : []).filter(function (row) { return row && typeof row.id === 'string'; }).map(function (row) {
          return { id: row.id, name: String(row.name || row.id), schema: row.schema ? String(row.schema) : '', kind: row.kind === 'collection' ? 'collection' : row.kind === 'view' ? 'view' : 'table' };
        });
        pane.entitiesLoaded = true;
        if (pane.entityId && !entity(pane)) {
          pane.recordEpoch++;
          pane.entityId = null;
          pane.records = null;
          pane.recordsLoading = false;
          pane.selectedRow = null;
        }
      }
      paint(pane);
      if (result.ok && pane.entityId && !pane.records && !pane.recordsLoading) fetchRecords(pane, pane.entityId);
    });
  }

  function fetchRecords(pane, entityId) {
    var connectionId = pane.connectionId;
    if (!connectionId || !entityId) return Promise.resolve();
    var epoch = ++pane.recordEpoch;
    pane.entityId = entityId;
    pane.menu = '';
    pane.recordsLoading = true;
    pane.records = null;
    pane.selectedRow = null;
    pane.error = '';
    pane.errorKind = '';
    pane.scrollTop = 0;
    pane.scrollLeft = 0;
    paint(pane);
    focus(pane, 'entity-picker');
    return call('databaseRecords', pane.wsId, connectionId, entityId).then(function (result) {
      if (!live(pane) || epoch !== pane.recordEpoch || connectionId !== pane.connectionId || entityId !== pane.entityId) return;
      pane.recordsLoading = false;
      if (!result.ok) {
        pane.error = message(result, 'Could not fetch records.');
        pane.errorKind = 'records';
      } else if (!Array.isArray(result.rows) || !Array.isArray(result.columns)) {
        pane.error = 'The database returned an unreadable result. Try again.';
        pane.errorKind = 'records';
      } else {
        pane.records = {
          rows: result.rows,
          columns: result.columns.map(function (col) { return { name: String(col.name), type: String(col.type || '') }; }),
          fetchedAt: result.fetchedAt || new Date().toISOString()
        };
      }
      paint(pane);
    });
  }

  function connectionMenu(pane) {
    var menu = h('div.db-menu', { role: 'menu', 'aria-label': 'Workspace connections' }, h('div.db-menu-caption', null, 'Connections in ' + pane.wsId));
    pane.connections.forEach(function (connection) {
      var row = h('div.db-menu-row');
      row.appendChild(h('button.db-menu-item' + (connection.id === pane.connectionId ? '.selected' : ''), {
        type: 'button', role: 'menuitem', dataset: { dbConnection: connection.id }, 'data-db-focus': 'connection:' + connection.id
      }, brand(connection.provider), h('span.db-copy', null, h('b', null, connection.name), h('small', null, providerLabel(connection.provider) + (connection.database ? ' · ' + connection.database : ''))), connection.id === pane.connectionId ? icon('check', 'db-check') : null));
      row.appendChild(h('button.db-remove', { type: 'button', dataset: { dbRemove: connection.id }, 'aria-label': 'Remove ' + connection.name + ' connection', title: 'Remove connection', 'data-db-focus': 'remove:' + connection.id }, icon('trash')));
      menu.appendChild(row);
    });
    menu.appendChild(h('div.db-menu-bottom', null, btn([icon('plus'), 'Add connection'], 'add', 'quiet', { role: 'menuitem' })));
    return menu;
  }

  function entityMenu(pane) {
    var mongo = current(pane).provider === 'mongodb';
    var menu = h('div.db-menu.db-entity-menu', { role: 'menu', 'aria-label': 'Database entities' }, h('div.db-menu-caption', null, mongo ? 'Collections' : 'Tables and views'));
    pane.entities.forEach(function (item) {
      menu.appendChild(h('button.db-menu-item' + (item.id === pane.entityId ? '.selected' : ''), {
        type: 'button', role: 'menuitem', dataset: { dbEntity: item.id }, 'data-db-focus': 'entity:' + item.id
      }, h('span.db-entity-glyph', null, icon(item.kind === 'collection' ? 'document' : 'table')), h('span.db-copy', null, h('b', null, item.name), h('small', null, item.kind === 'collection' ? 'Collection' : (item.schema ? item.schema + ' · ' : '') + (item.kind === 'view' ? 'View' : 'Table'))), item.id === pane.entityId ? icon('check', 'db-check') : null));
    });
    return menu;
  }

  function controls(pane) {
    var connection = current(pane);
    var chosen = entity(pane);
    var connectionField = h('div.db-field-group.db-connection', null,
      h('label.db-field-label', { id: 'db-connection-label-' + pane.wsId }, 'Connection'),
      h('button.db-picker', {
        type: 'button', dataset: { dbAction: 'connection-picker' }, 'data-db-focus': 'connection-picker',
        'aria-label': 'Connection: ' + connection.name, 'aria-haspopup': 'menu', 'aria-expanded': String(pane.menu === 'connection')
      }, brand(connection.provider), h('strong', null, connection.name), icon('chevron', 'db-arrow')),
      pane.menu === 'connection' ? connectionMenu(pane) : null);
    var choose = pane.entitiesLoading ? 'Loading entities…' : chosen ? chosen.name : connection.provider === 'mongodb' ? 'Choose a collection…' : 'Choose a table…';
    var entityField = h('div.db-field-group.db-entity', null,
      h('label.db-field-label', null, 'Entity'),
      h('button.db-picker', {
        type: 'button', dataset: { dbAction: 'entity-picker' }, 'data-db-focus': 'entity-picker',
        disabled: pane.entitiesLoading || !pane.entities.length || null,
        'aria-label': 'Entity: ' + choose, 'aria-haspopup': 'menu', 'aria-expanded': String(pane.menu === 'entity')
      }, icon(connection.provider === 'mongodb' ? 'document' : 'table'), h('strong', null, choose), icon('chevron', 'db-arrow')),
      pane.menu === 'entity' ? entityMenu(pane) : null);
    return h('div.db-controls', null, connectionField, entityField,
      btn([icon('refresh', pane.recordsLoading ? 'spin' : ''), 'Refresh'], 'refresh', 'refresh', { disabled: pane.recordsLoading || pane.entitiesLoading || null, title: pane.entityId ? 'Fetch every record again' : 'Reload database entities' }),
      btn([icon('plus'), 'Add connection'], 'add', 'add'));
  }

  function placeholder(title, copy, glyph) {
    return h('div.db-placeholder', { role: 'status' }, h('div', null, h('div.db-bigicon', null, icon(glyph || 'table', glyph === 'refresh' ? 'spin' : '')), h('h3', null, title), h('p', null, copy)));
  }

  function cell(value) {
    if (value === null) return h('span.db-null', null, 'null');
    if (value === undefined) return h('span.db-null', null, '—');
    if (Array.isArray(value)) return h('span.db-object', null, '[' + value.length + ' ' + (value.length === 1 ? 'item' : 'items') + ']');
    if (typeof value === 'object') return h('span.db-object', null, '{ ' + Object.keys(value).length + ' fields }');
    var text = String(value);
    return h('span.db-value', { title: text.length > 40 ? text : null }, text);
  }

  function recordRow(pane, index) {
    var row = pane.records.rows[index];
    var tr = h('tr' + (pane.selectedRow === index ? '.selected' : ''), {
      tabindex: '0', role: 'button', 'aria-label': 'View record ' + (index + 1), 'aria-rowindex': index + 2,
      dataset: { dbRow: index }, 'data-db-focus': 'row:' + index, style: { height: ROW_HEIGHT + 'px' }
    });
    pane.records.columns.forEach(function (column) {
      tr.appendChild(h('td', null, cell(row && Object.prototype.hasOwnProperty.call(row, column.name) ? row[column.name] : undefined)));
    });
    tr.appendChild(h('td.db-row-open', null, icon('right', 'db-row-arrow')));
    return tr;
  }

  function spacer(pane, pixels) {
    return h('tr.db-spacer', { 'aria-hidden': 'true', style: { height: pixels + 'px' } }, h('td', { colspan: pane.records.columns.length + 1, style: { height: pixels + 'px', padding: '0', border: '0' } }));
  }

  function paintRows(pane, force) {
    if (!pane.tableScroll || !pane.tbody || !pane.records) return;
    var count = pane.records.rows.length;
    var scrollTop = force ? pane.scrollTop : pane.tableScroll.scrollTop;
    var first = Math.max(0, Math.floor(Math.max(0, scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - 8);
    var visible = Math.max(28, Math.min(80, Math.ceil((pane.tableScroll.clientHeight || 700) / ROW_HEIGHT) + 16));
    var last = Math.min(count, first + visible);
    if (!force && first === pane.firstRow && last === pane.lastRow) return;
    var held = focusKey(pane);
    pane.firstRow = first;
    pane.lastRow = last;
    D.clear(pane.tbody);
    if (first) pane.tbody.appendChild(spacer(pane, first * ROW_HEIGHT));
    for (var i = first; i < last; i++) pane.tbody.appendChild(recordRow(pane, i));
    if (last < count) pane.tbody.appendChild(spacer(pane, (count - last) * ROW_HEIGHT));
    if (held && held.indexOf('row:') === 0) focus(pane, held);
  }

  function records(pane) {
    var connection = current(pane);
    var selected = entity(pane);
    var count = pane.records.rows.length;
    var table = h('table.db-table', { 'aria-label': selected.name + ' records', 'aria-rowcount': count + 1, style: { minWidth: Math.max(790, pane.records.columns.length * 190 + 42) + 'px' } });
    var colgroup = h('colgroup');
    pane.records.columns.forEach(function () { colgroup.appendChild(h('col', { style: { width: '190px' } })); });
    colgroup.appendChild(h('col', { style: { width: '42px' } }));
    table.appendChild(colgroup);
    var header = h('tr');
    pane.records.columns.forEach(function (column) { header.appendChild(h('th', { scope: 'col' }, column.name, h('small', null, column.type))); });
    header.appendChild(h('th', { 'aria-label': 'Open record' }));
    table.appendChild(h('thead', null, header));
    pane.tbody = h('tbody');
    table.appendChild(pane.tbody);
    pane.tableScroll = h('div.db-table-scroll', null, table);
    pane.tableScroll.addEventListener('scroll', function () {
      pane.scrollTop = pane.tableScroll.scrollTop;
      pane.scrollLeft = pane.tableScroll.scrollLeft;
      if (pane.frame !== null) return;
      pane.frame = requestAnimationFrame(function () { pane.frame = null; paintRows(pane, false); });
    });
    var fetched = D.fmtAgo(pane.records.fetchedAt);
    var box = h('div.db-records', null,
      h('div.db-records-head', null, icon(selected.kind === 'collection' ? 'document' : 'table'), h('h3', null, selected.name), h('span.db-schema', null, selected.kind === 'collection' ? 'collection' : selected.schema || selected.kind), h('span.db-record-count', null, D.plural(count, 'record') + (fetched ? ' · ' + fetched : ''))),
      pane.tableScroll,
      count ? null : h('div.db-no-records', { role: 'status' }, 'This entity has no records.'),
      h('div.db-records-foot', null, h('span', null, 'All ' + D.plural(count, 'record') + ' fetched'), h('span', null, providerLabel(connection.provider) + (connection.database ? ' · ' + connection.database : ''))));
    return box;
  }

  function jsonMarkup(value) {
    var text;
    try { text = JSON.stringify(value, null, 2); } catch (err) { text = 'This record could not be displayed.'; }
    var pre = h('pre', { tabindex: '0', 'aria-label': 'Record JSON' });
    text = text === undefined ? 'null' : text;
    if (text.length > 200 * 1024) { pre.textContent = text; return pre; }
    var expression = /"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/g;
    var start = 0;
    var match;
    var tokens = 0;
    while ((match = expression.exec(text))) {
      // A highly structured document needs no tens of thousands of color spans.
      if (++tokens > 1500) { pre.textContent = text; return pre; }
      pre.appendChild(D.text(text.slice(start, match.index)));
      var token = match[0];
      var cls = token.charAt(0) === '"' ? /:\s*$/.test(token) ? 'db-json-key' : 'db-json-string' : 'db-json-number';
      pre.appendChild(h('span.' + cls, null, token));
      start = match.index + token.length;
    }
    pre.appendChild(D.text(text.slice(start)));
    return pre;
  }

  function drawer(pane) {
    if (!pane.records || pane.selectedRow === null) return null;
    var row = pane.records.rows[pane.selectedRow];
    if (row === undefined) return null;
    return h('aside.db-drawer', { 'aria-label': 'Record details' },
      h('div.db-drawer-head', null, icon('document'), h('h3', null, 'Record details'), btn(icon('close'), 'close-row', 'close', { 'aria-label': 'Close record details' })),
      h('div.db-drawer-meta', null, h('span', null, entity(pane).name), h('span', null, '·'), h('span', null, (pane.selectedRow + 1) + ' of ' + pane.records.rows.length)),
      jsonMarkup(row));
  }

  function paint(pane) {
    if (pane.disposed) return;
    var held = focusKey(pane);
    if (pane.tableScroll) { pane.scrollTop = pane.tableScroll.scrollTop; pane.scrollLeft = pane.tableScroll.scrollLeft; }
    pane.tableScroll = null;
    pane.tbody = null;
    pane.firstRow = -1;
    pane.lastRow = -1;
    D.clear(pane.content);
    if (pane.error) pane.content.appendChild(h('div.db-notice.err', { role: 'alert' }, h('span', null, pane.error), btn('Try again', 'retry', 'small')));
    var connection = current(pane);
    if (!pane.listLoaded && pane.listLoading) {
      pane.content.appendChild(placeholder('Loading connections…', 'The saved databases for this workspace.', 'refresh'));
    } else if (!connection) {
      pane.content.appendChild(h('div.db-empty', null, h('div', null, h('div.db-bigicon', null, icon('database')), h('h3', null, 'Your data, one connection away.'), h('p', null, 'Add a database to this workspace, then choose an entity to see its records.'), btn([icon('plus'), 'Add connection'], 'add', 'primary'), h('div.db-providers', null, 'Neon / PostgreSQL', h('span', null, '·'), 'MongoDB'))));
    } else {
      pane.content.appendChild(controls(pane));
      if (pane.recordsLoading) {
        pane.content.appendChild(placeholder('Fetching records…', (entity(pane) ? entity(pane).name + ' · ' : '') + connection.name, 'refresh'));
      } else if (pane.records) {
        pane.content.appendChild(records(pane));
        pane.content.appendChild(h('div.db-tip', null, icon('right'), 'Click a record to see all of its fields.'));
        var details = drawer(pane);
        if (details) pane.content.appendChild(details);
      } else if (pane.entitiesLoading) {
        pane.content.appendChild(placeholder('Loading entities…', connection.name, 'refresh'));
      } else if (pane.entitiesLoaded && !pane.entities.length) {
        pane.content.appendChild(placeholder('No entities found', 'This database has no accessible ' + (connection.provider === 'mongodb' ? 'collections' : 'tables or views') + '.'));
      } else {
        pane.content.appendChild(placeholder(pane.errorKind === 'records' ? 'Records could not be fetched' : 'Choose an entity', pane.errorKind === 'records' ? 'Try again to fetch the complete result.' : 'Select a ' + (connection.provider === 'mongodb' ? 'collection' : 'table') + ' to fetch all of its records.'));
      }
    }
    if (pane.tableScroll) {
      paintRows(pane, true);
      pane.tableScroll.scrollTop = pane.scrollTop;
      pane.tableScroll.scrollLeft = pane.scrollLeft;
      if (pane.frame !== null) cancelAnimationFrame(pane.frame);
      pane.frame = requestAnimationFrame(function () { pane.frame = null; paintRows(pane, false); });
    }
    if (held && !pane.modal) focus(pane, held);
  }

  function openModal(pane) {
    if (pane.modal) return;
    pane.returnFocus = focusKey(pane) || 'add';
    pane.menu = '';
    pane.selectedRow = null;
    paint(pane);
    var nameInput = h('input', { id: 'db-connection-name', type: 'text', autocomplete: 'off', placeholder: 'e.g. Main database', maxlength: '80', 'data-db-focus': 'modal-name' });
    var uriInput = h('input', { id: 'db-connection-uri', type: 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none', placeholder: 'postgresql://user:password@host.example.com/app', 'data-db-focus': 'modal-uri' });
    var helper = h('div.db-helper', null, 'Paste your Neon or PostgreSQL connection URI, including the database name.');
    var error = h('div.db-form-error', { role: 'alert' });
    var submit = h('button.db-btn.primary', { type: 'submit', disabled: true, 'data-db-focus': 'modal-submit' }, 'Connect');
    var providers = h('div.db-provider-options', { role: 'group', 'aria-label': 'Database type' },
      btn([brand('postgres'), h('span', null, 'Neon', h('small', null, 'PostgreSQL'))], 'provider-postgres', 'provider-option on', { 'aria-pressed': 'true' }),
      btn([brand('mongodb'), h('span', null, 'MongoDB', h('small', null, 'Collections'))], 'provider-mongodb', 'provider-option', { 'aria-pressed': 'false' }));
    var form = h('form.db-form', null,
      h('div.db-entry', null, h('label', { for: 'db-connection-name' }, 'Connection name'), nameInput),
      h('div.db-entry', null, h('label', null, 'Database type'), providers),
      h('div.db-entry', null, h('label', { for: 'db-connection-uri' }, 'Connection URI'), h('div.db-uri-wrap', null, uriInput, btn('Show', 'show-uri', 'quiet', { 'aria-label': 'Show connection URI' })), helper, error),
      h('div.db-form-actions', null, h('span.db-form-note', null, icon('lock'), 'Read only'), btn('Cancel', 'cancel-modal'), submit));
    var dialog = h('section.db-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'db-modal-title' },
      h('div.db-modal-head', null, h('h2#db-modal-title', null, 'Add connection'), btn(icon('close'), 'cancel-modal', 'close', { 'aria-label': 'Close connection dialog' })),
      h('div.db-modal-desc', null, 'Saved to ' + pane.wsId + ' · Add as many as you need.'), form);
    var veil = h('div.db-veil', null, dialog);
    pane.modal = { kind: 'add', dialog: dialog, form: form, name: nameInput, uri: uriInput, helper: helper, error: error, submit: submit, providers: providers, provider: 'postgres', busy: false };
    D.clear(pane.overlay);
    pane.overlay.appendChild(veil);
    focus(pane, 'modal-name');
  }

  function closeModal(pane, restoreFocus) {
    if (!pane.modal) return;
    pane.modalEpoch++;
    if (pane.modal.uri) { pane.modal.uri.value = ''; pane.modal.uri.type = 'password'; }
    pane.modal = null;
    D.clear(pane.overlay);
    if (restoreFocus !== false) focus(pane, pane.returnFocus || 'add');
    pane.returnFocus = null;
  }

  function validateForm(pane) {
    var modal = pane.modal;
    if (!modal || modal.kind !== 'add') return;
    modal.submit.disabled = modal.busy || !modal.name.value.trim() || !modal.uri.value.trim();
  }

  function setProvider(pane, provider) {
    var modal = pane.modal;
    if (!modal || modal.kind !== 'add' || modal.busy) return;
    modal.provider = provider;
    Array.prototype.forEach.call(modal.providers.children, function (button) {
      var on = button.dataset.dbAction === 'provider-' + provider;
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    });
    modal.uri.placeholder = provider === 'mongodb' ? 'mongodb+srv://user:password@cluster.example.com/app' : 'postgresql://user:password@host.example.com/app';
    modal.helper.textContent = provider === 'mongodb' ? 'Paste a MongoDB connection URI, including the database name.' : 'Paste your Neon or PostgreSQL connection URI, including the database name.';
    modal.error.textContent = '';
    validateForm(pane);
  }

  function addConnection(pane) {
    var modal = pane.modal;
    if (!modal || modal.kind !== 'add' || modal.busy) return;
    var name = modal.name.value.trim();
    var uri = modal.uri.value.trim();
    if (!name || !uri) return;
    var provider = modal.provider;
    var valid = provider === 'mongodb' ? /^mongodb(?:\+srv)?:\/\//i.test(uri) : /^postgres(?:ql)?:\/\//i.test(uri);
    if (!valid) {
      modal.error.textContent = 'Use a ' + (provider === 'mongodb' ? 'mongodb:// or mongodb+srv://' : 'postgresql:// or postgres://') + ' URI.';
      modal.uri.focus();
      return;
    }
    var epoch = ++pane.modalEpoch;
    modal.busy = true;
    modal.error.textContent = '';
    modal.submit.textContent = 'Connecting…';
    modal.uri.value = '';
    modal.uri.type = 'password';
    Array.prototype.forEach.call(modal.form.querySelectorAll('input, button'), function (item) {
      if (item.dataset.dbAction !== 'cancel-modal') item.disabled = true;
    });
    var request = call('databaseAdd', pane.wsId, { name: name, provider: provider, uri: uri });
    uri = '';
    request.then(function (result) {
      if (pane.disposed) return;
      // Saving a connection may finish after the user leaves this dialog. Re-read
      // its workspace next time, but never reopen it or select it in another view.
      if (epoch !== pane.modalEpoch || pane.modal !== modal || !live(pane)) {
        if (result.ok) {
          pane.listLoaded = false;
          if (live(pane)) loadConnections(pane);
        }
        return;
      }
      modal.busy = false;
      if (!result.ok) {
        modal.error.textContent = message(result, 'Could not connect to this database.');
        modal.submit.textContent = 'Connect';
        Array.prototype.forEach.call(modal.form.querySelectorAll('input, button'), function (item) { item.disabled = false; });
        validateForm(pane);
        focus(pane, 'modal-uri');
        return;
      }
      closeModal(pane, false);
      pane.listEpoch++;
      pane.listLoading = false;
      pane.listLoaded = true;
      if (Array.isArray(result.connections)) pane.connections = metadata(result.connections);
      var added = metadata(result.connection ? [result.connection] : [])[0];
      if (added && !pane.connections.some(function (connection) { return connection.id === added.id; })) pane.connections.push(added);
      pane.connectionId = added ? added.id : pane.connections[0] ? pane.connections[0].id : null;
      resetEntity(pane);
      pane.error = '';
      pane.menu = '';
      paint(pane);
      focus(pane, 'connection-picker');
      if (pane.connectionId) loadEntities(pane);
    });
  }

  function removeDialog(pane, id) {
    var connection = pane.connections.filter(function (item) { return item.id === id; })[0];
    if (!connection || pane.modal) return;
    pane.returnFocus = 'connection-picker';
    pane.menu = '';
    paint(pane);
    var error = h('div.db-form-error', { role: 'alert' });
    var submit = btn('Remove connection', 'confirm-remove', 'primary');
    var dialog = h('section.db-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'db-modal-title' },
      h('div.db-modal-head', null, h('h2#db-modal-title', null, 'Remove connection?'), btn(icon('close'), 'cancel-modal', 'close', { 'aria-label': 'Close removal dialog' })),
      h('div.db-modal-desc', null, 'Remove “' + connection.name + '” from ' + pane.wsId + '? This only removes the saved connection. The database and its records stay in place.'),
      h('div.db-form', null, error, h('div.db-form-actions', null, btn('Cancel', 'cancel-modal'), submit)));
    pane.modal = { kind: 'remove', dialog: dialog, connectionId: id, error: error, submit: submit, busy: false };
    D.clear(pane.overlay);
    pane.overlay.appendChild(h('div.db-veil', null, dialog));
    focus(pane, 'cancel-modal');
  }

  function removeConnection(pane) {
    var modal = pane.modal;
    if (!modal || modal.kind !== 'remove' || modal.busy) return;
    var epoch = ++pane.modalEpoch;
    modal.busy = true;
    modal.submit.disabled = true;
    modal.submit.textContent = 'Removing…';
    call('databaseRemove', pane.wsId, modal.connectionId).then(function (result) {
      if (pane.disposed) return;
      if (epoch !== pane.modalEpoch || pane.modal !== modal || !live(pane)) {
        if (result.ok) {
          pane.listLoaded = false;
          if (live(pane)) loadConnections(pane);
        }
        return;
      }
      if (!result.ok) {
        modal.busy = false;
        modal.submit.disabled = false;
        modal.submit.textContent = 'Remove connection';
        modal.error.textContent = message(result, 'Could not remove the saved connection.');
        return;
      }
      closeModal(pane, false);
      pane.listEpoch++;
      pane.listLoading = false;
      pane.connections = Array.isArray(result.connections) ? metadata(result.connections) : pane.connections.filter(function (connection) { return connection.id !== modal.connectionId; });
      if (pane.connectionId === modal.connectionId) {
        pane.connectionId = pane.connections[0] ? pane.connections[0].id : null;
        resetEntity(pane);
      }
      pane.error = '';
      paint(pane);
      focus(pane, pane.connectionId ? 'connection-picker' : 'add');
      if (pane.connectionId && !pane.entitiesLoaded) loadEntities(pane);
    });
  }

  function retry(pane) {
    if (pane.errorKind === 'connections') loadConnections(pane);
    else if (pane.errorKind === 'records' && pane.entityId) fetchRecords(pane, pane.entityId);
    else loadEntities(pane);
  }

  function openRow(pane, index) {
    if (!pane.records || index < 0 || index >= pane.records.rows.length) return;
    pane.selectedRow = index;
    pane.menu = '';
    paint(pane);
    focus(pane, 'close-row');
  }

  function closeRow(pane) {
    var index = pane.selectedRow;
    pane.selectedRow = null;
    paint(pane);
    if (index !== null) focus(pane, 'row:' + index);
  }

  function click(pane, event) {
    if (!live(pane)) return;
    var button = event.target.closest('button');
    if (button && button.disabled) return;
    if (button && pane.root.contains(button)) {
      var action = button.dataset.dbAction;
      if (button.dataset.dbConnection) { selectConnection(pane, button.dataset.dbConnection); return; }
      if (button.dataset.dbEntity) { fetchRecords(pane, button.dataset.dbEntity); return; }
      if (button.dataset.dbRemove) { removeDialog(pane, button.dataset.dbRemove); return; }
      if (action === 'connection-picker' || action === 'entity-picker') {
        var menu = action === 'connection-picker' ? 'connection' : 'entity';
        pane.menu = pane.menu === menu ? '' : menu;
        pane.selectedRow = null;
        paint(pane);
        if (pane.menu) {
          var selected = pane.content.querySelector('.db-menu-item.selected') || pane.content.querySelector('.db-menu-item');
          if (selected) selected.focus();
        } else focus(pane, action);
      } else if (action === 'add') openModal(pane);
      else if (action === 'cancel-modal') closeModal(pane, true);
      else if (action === 'provider-postgres') setProvider(pane, 'postgres');
      else if (action === 'provider-mongodb') setProvider(pane, 'mongodb');
      else if (action === 'show-uri' && pane.modal && pane.modal.uri) {
        var show = pane.modal.uri.type === 'password';
        pane.modal.uri.type = show ? 'text' : 'password';
        button.textContent = show ? 'Hide' : 'Show';
        button.setAttribute('aria-label', (show ? 'Hide' : 'Show') + ' connection URI');
      } else if (action === 'refresh') {
        if (pane.entityId) fetchRecords(pane, pane.entityId);
        else loadEntities(pane);
      } else if (action === 'retry') retry(pane);
      else if (action === 'close-row') closeRow(pane);
      else if (action === 'confirm-remove') removeConnection(pane);
      return;
    }
    if (pane.modal) return;
    var row = event.target.closest('[data-db-row]');
    if (row && pane.root.contains(row)) { openRow(pane, Number(row.dataset.dbRow)); return; }
    if (pane.menu && !event.target.closest('.db-menu')) { pane.menu = ''; paint(pane); }
  }

  function localKey(pane, event) {
    if (!live(pane)) return;
    if (pane.modal && event.key === 'Tab') {
      var items = Array.prototype.filter.call(pane.modal.dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]'), function (el) { return !el.hidden; });
      var first = items[0];
      var last = items[items.length - 1];
      var active = document.activeElement;
      if (event.shiftKey && (active === first || items.indexOf(active) < 0)) { event.preventDefault(); if (last) last.focus(); }
      else if (!event.shiftKey && (active === last || items.indexOf(active) < 0)) { event.preventDefault(); if (first) first.focus(); }
      return;
    }
    if (pane.modal) return;
    if (pane.menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].indexOf(event.key) >= 0) {
      var options = Array.prototype.slice.call(pane.content.querySelectorAll('.db-menu button:not(:disabled)'));
      if (!options.length) return;
      var index = options.indexOf(document.activeElement);
      var next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : event.key === 'ArrowDown' ? (index + 1) % options.length : (index - 1 + options.length) % options.length;
      event.preventDefault();
      event.stopPropagation();
      options[next].focus();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-db-row]')) {
      event.preventDefault();
      event.stopPropagation();
      openRow(pane, Number(event.target.dataset.dbRow));
    }
  }

  function swapHeader(pane, ws, state) {
    var held = pane.hd && pane.hd.contains(document.activeElement) ? Array.prototype.indexOf.call(pane.hd.querySelectorAll('button,h1.jump'), document.activeElement) : -1;
    var header = SB.views.workspace.header(ws, state);
    if (pane.hd && pane.hd.parentNode === pane.root) pane.root.replaceChild(header, pane.hd);
    else pane.root.insertBefore(header, pane.root.firstChild);
    pane.hd = header;
    if (held >= 0) {
      var item = header.querySelectorAll('button,h1.jump')[held];
      if (item) { try { item.focus({ preventScroll: true }); } catch (err) { item.focus(); } }
    }
  }

  function shown(route) {
    var next = onTab(route) ? String(route.wsId) : null;
    if (next === activeId) return;
    var previous = activeId ? panes.get(activeId) : null;
    if (previous) invalidate(previous);
    activeId = next;
    var pane = next ? panes.get(next) : null;
    if (pane) {
      paint(pane);
      if (!pane.listLoaded && !pane.listLoading) loadConnections(pane);
      else if (pane.connectionId && !pane.entitiesLoaded && !pane.entitiesLoading) loadEntities(pane);
      else if (pane.entityId && !pane.records && !pane.recordsLoading) fetchRecords(pane, pane.entityId);
    }
  }

  function render(state) {
    var route = state && state.route || {};
    shown(route);
    if (!onTab(route)) return h('div.view', null, D.empty('Pick a workspace on the left.', { title: 'No workspace selected' }));
    var ws = state.byId && state.byId[route.wsId] || { id: route.wsId };
    var pane = panes.get(ws.id) || build(ws.id);
    swapHeader(pane, ws, state);
    if (!pane.listLoaded && !pane.listLoading && pane.errorKind !== 'connections') loadConnections(pane);
    else if (pane.connectionId && !pane.entitiesLoaded && !pane.entitiesLoading && pane.errorKind !== 'entities') loadEntities(pane);
    if (!pane.content.firstChild) paint(pane);
    return pane.root;
  }

  function onKey(event) {
    var pane = activeId ? panes.get(activeId) : null;
    if (!pane || !pane.root.isConnected) return false;
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (pane.modal) { closeModal(pane, true); return true; }
      if (pane.menu) { var menu = pane.menu; pane.menu = ''; paint(pane); focus(pane, menu + '-picker'); return true; }
      if (pane.selectedRow !== null) { closeRow(pane); return true; }
      return false;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 'r') {
      if (pane.modal) return true;
      if (pane.recordsLoading || pane.entitiesLoading || pane.listLoading) return true;
      if (pane.entityId) fetchRecords(pane, pane.entityId);
      else if (pane.connectionId) loadEntities(pane);
      else loadConnections(pane);
      return true;
    }
    // A submit shortcut in the add dialog must not start this workspace too.
    return !!pane.modal && (event.metaKey || event.ctrlKey) && event.key === 'Enter';
  }

  function refresh(fetch) {
    // Window focus is a local repaint only. Only the explicit Refresh action asks
    // a database for data; focus should not repeatedly query a remote service.
    if (!fetch) return;
    var pane = activeId ? panes.get(activeId) : null;
    if (!pane || pane.modal || pane.listLoading || pane.entitiesLoading || pane.recordsLoading) return;
    if (pane.entityId) fetchRecords(pane, pane.entityId);
    else if (pane.connectionId) loadEntities(pane);
    else loadConnections(pane);
  }

  function ids() { return Array.from(panes.keys()); }
  function dispose(wsId) {
    var pane = panes.get(wsId);
    if (!pane || pane.root.isConnected) return;
    invalidate(pane);
    pane.listEpoch++;
    pane.disposed = true;
    pane.records = null;
    pane.connections = [];
    pane.entities = [];
    panes.delete(wsId);
    if (activeId === wsId) activeId = null;
  }

  SB.views.databases = { render: render, shown: shown, onKey: onKey, refresh: refresh, ids: ids, dispose: dispose };
})(window.SB);
