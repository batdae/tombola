/* Interface de la tombola NAM-IP. Toute la logique de tirage est dans engine.js. */
(function () {
  'use strict';

  const E = globalThis.TombolaEngine;
  const KEY_PREP = 'tombola-namip:preparation';
  const KEY_RECORD = 'tombola-namip:tirage';

  // prep : données importées avant tirage. record : tirage figé (local ou importé).
  let prep = { lots: null, achats: null, demo: false };
  let record = null;
  let index = null;
  let recordCorrupt = null;
  let saveFailed = false;
  let drawing = false;
  let currentTab = 'prep';

  const $ = id => document.getElementById(id);

  function el(tag, props) {
    const n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(k => {
        if (k === 'class') n.className = props[k];
        else if (k === 'text') n.textContent = props[k];
        else n.setAttribute(k, props[k]);
      });
    }
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  function fill(id) {
    const node = clear($(id));
    for (let i = 1; i < arguments.length; i++) if (arguments[i]) node.appendChild(arguments[i]);
    return node;
  }

  function msgBox(kind, title, items) {
    return el('div', { class: 'msg ' + kind }, el('h3', { text: title }),
      items && items.length ? el('ul', null, ...items.map(t => el('li', { text: t }))) : null);
  }

  function fmtErrors(errors) {
    return errors.map(e => (e.line ? 'Ligne ' + e.line + ' : ' : '') + e.message);
  }

  // ---------- Stockage local ----------

  function storageRead(key) {
    try {
      const raw = localStorage.getItem(key);
      return { ok: true, value: raw === null ? null : JSON.parse(raw) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function storageWrite(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function storageRemove(key) {
    try {
      localStorage.removeItem(key);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function alertStorage(action, err) {
    $('alerts').appendChild(el('div', { class: 'alert-big', role: 'alert' },
      'Stockage local du navigateur indisponible (' + action + ') : ' + (err && err.message ? err.message : String(err)) +
      '. Rien n\'est garanti sur cet ordinateur : le fichier CSV du résultat est la seule vraie sauvegarde.'));
  }

  function savePrep() {
    const w = storageWrite(KEY_PREP, {
      demo: prep.demo,
      lots: prep.lots && { fileName: prep.lots.fileName, lots: prep.lots.lots },
      achats: prep.achats && { fileName: prep.achats.fileName, achats: prep.achats.achats }
    });
    if (!w.ok) alertStorage('enregistrement des imports', w.error);
  }

  function loadPrep() {
    const r = storageRead(KEY_PREP);
    if (!r.ok) { alertStorage('lecture des imports', r.error); return; }
    const v = r.value;
    if (!v) return;
    const restored = { lots: null, achats: null, demo: !!v.demo };
    if (v.lots && Array.isArray(v.lots.lots)) {
      const res = E.validateLotRows(v.lots.lots.map((l, i) => ({ line: i + 2, lot_id: l.lot_id, description: l.description })));
      if (res.ok) restored.lots = { fileName: v.lots.fileName, lots: res.lots, infos: res.infos };
    }
    if (v.achats && Array.isArray(v.achats.achats)) {
      const res = E.validateAchatRows(v.achats.achats.map((a, i) => ({
        line: i + 2, acheteur_id: a.acheteur_id, nom: a.nom, ticket_debut: a.debut, ticket_fin: a.fin
      })));
      if (res.ok) restored.achats = { fileName: v.achats.fileName, achats: res.achats, infos: res.infos };
    }
    prep = restored;
  }

  function setRecord(rec) {
    record = rec;
    index = rec ? E.buildIndex(rec) : null;
    recordCorrupt = null;
  }

  // Lit le tirage stocké. Un tirage illisible verrouille quand même l'app : on ne retire jamais par accident.
  function loadRecord() {
    const r = storageRead(KEY_RECORD);
    if (!r.ok) { alertStorage('lecture du tirage', r.error); return; }
    if (!r.value) { setRecord(null); return; }
    const errs = E.checkRecord(r.value);
    if (errs.length) {
      record = null;
      index = null;
      recordCorrupt = errs;
      return;
    }
    setRecord(r.value);
  }

  // ---------- Téléchargements ----------

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function downloadResult() {
    if (record) download(E.resultFileName(record), E.exportResultCSV(record));
  }

  // ---------- Fenêtre de confirmation ----------

  let dlgOnOk = null;
  let swallowUntil = 0;

  // Après une confirmation, le second clic d'un double clic tomberait sur le bouton
  // affiché à la même place (ex. « Importer un résultat ») : on l'ignore brièvement.
  // Seuls les clics de souris réels sont filtrés (detail > 0) : ni le clic programmé du
  // téléchargement, ni la validation au clavier par Entrée.
  ['mousedown', 'click'].forEach(type => document.addEventListener(type, e => {
    if (e.isTrusted && e.detail > 0 && Date.now() < swallowUntil) { e.preventDefault(); e.stopPropagation(); }
  }, true));

  function openDialog(opts) {
    const dlg = $('dlg');
    if (dlg.open) return;
    $('dlg-title').textContent = opts.title;
    fill('dlg-body', ...opts.body);
    const input = $('dlg-input');
    const ok = $('dlg-ok');
    ok.textContent = opts.okLabel;
    ok.className = 'btn' + (opts.danger ? ' danger' : '');
    input.value = '';
    input.hidden = !opts.requireText;
    ok.disabled = !!opts.requireText;
    input.oninput = () => { ok.disabled = input.value.trim() !== opts.requireText; };
    dlgOnOk = opts.onOk;
    dlg.showModal();
    if (opts.requireText) input.focus(); else ok.focus();
  }

  $('dlg-ok').addEventListener('click', () => {
    const ok = $('dlg-ok');
    if (ok.disabled || !dlgOnOk) return;
    ok.disabled = true;
    swallowUntil = Date.now() + 500;
    const fn = dlgOnOk;
    dlgOnOk = null;
    $('dlg').close();
    fn();
  });
  $('dlg-cancel').addEventListener('click', () => { dlgOnOk = null; $('dlg').close(); });
  $('dlg').addEventListener('close', () => { dlgOnOk = null; });

  // ---------- Rendu ----------

  function isLocked() { return !!record || !!recordCorrupt; }

  function prepReady() { return !!(prep.lots && prep.achats); }

  function showsDemo() { return record ? !!record.demo : prep.demo; }

  function currentData() {
    if (record) return { lots: record.lots, achats: record.achats };
    if (prepReady()) return { lots: prep.lots.lots, achats: prep.achats.achats };
    return null;
  }

  function renderRecap(id) {
    const data = currentData();
    const node = clear($(id));
    if (!data) {
      node.appendChild(msgBox('info', 'Récapitulatif disponible après import des lots ET des achats.'));
      return;
    }
    const s = E.summarize(data.lots, data.achats);
    const mode = record ? record.mode : s.mode;
    const stat = (n, label) => el('div', { class: 'stat' }, el('b', { text: String(n) }), label);
    node.appendChild(el('div', { class: 'stats' },
      stat(s.P, 'acheteurs (P)'), stat(s.T, 'tickets (T)'), stat(s.L, 'lots (L)'), stat(s.K, 'lots attribués (K)')));
    node.appendChild(el('p', { class: 'mode', text: (record ? 'Mode appliqué — ' : '') + E.modeText(mode, s.P, s.L) }));
    if (s.nonAttribues > 0) {
      const detail = record
        ? 'Lots non attribués : ' + index.unassigned.map(l => 'n°' + l.lot_id).join(', ') + '.'
        : s.nonAttribues + ' lot(s) resteront non attribués (moins de tickets que de lots).';
      node.appendChild(el('p', { class: 'msg info', text: detail }));
    }
  }

  function table(headers, rows) {
    return el('table', null,
      el('thead', null, el('tr', null, ...headers.map(h => el('th', { text: h })))),
      el('tbody', null, ...rows.map(r => el('tr', null, ...r.map(c => el('td', { text: String(c) }))))));
  }

  function renderPreviews() {
    const data = currentData() || {
      lots: prep.lots ? prep.lots.lots : [],
      achats: prep.achats ? prep.achats.achats : []
    };
    fill('preview-lots', data.lots.length
      ? table(['Lot', 'Description'], data.lots.map(l => [l.lot_id, l.description]))
      : el('p', { class: 'muted', text: 'Aucun lot importé.' }));
    fill('preview-achats', data.achats.length
      ? table(['Acheteur', 'Nom', 'Premier ticket', 'Dernier ticket', 'Nombre'],
        data.achats.map(a => [a.acheteur_id, a.nom, a.debut, a.fin, a.fin - a.debut + 1]))
      : el('p', { class: 'muted', text: 'Aucun achat importé.' }));
  }

  function renderImportStatus() {
    if (!$('msg-lots').dataset.keep) {
      fill('msg-lots', prep.lots ? msgBox('ok', 'Lots : ' + (prep.lots.fileName || 'importés'), prep.lots.infos) : null);
    }
    if (!$('msg-achats').dataset.keep) {
      fill('msg-achats', prep.achats ? msgBox('ok', 'Achats : ' + (prep.achats.fileName || 'importés'), prep.achats.infos) : null);
    }
  }

  function renderBar() {
    const info = clear($('bar-info'));
    if (saveFailed) {
      info.appendChild(el('div', { class: 'alert-big', role: 'alert' },
        'L\'enregistrement du tirage sur cet ordinateur a ÉCHOUÉ. Le résultat n\'existe que dans cette page : ' +
        'téléchargez le CSV maintenant (bouton « Retélécharger le résultat ») et ne fermez pas cet onglet.'));
    }
    if (recordCorrupt) {
      info.appendChild(msgBox('error', 'Le tirage enregistré sur cet ordinateur est illisible. Importez le CSV du résultat.', recordCorrupt));
    }
    if (record) {
      info.appendChild(el('p', { class: 'msg info' },
        'Tirage ' + record.tirage_id + ' du ' + E.displayDate(record) + ' — ' + record.attributions.length + ' lot(s) attribué(s)' +
        (record.origine === 'import' ? ' — consultation d\'un résultat importé.' : '.')));
    } else if (!recordCorrupt) {
      info.appendChild(msgBox('info', 'Aucun tirage sur cet ordinateur : faites le tirage (onglet 2) ou importez un résultat.'));
    }
    $('search').disabled = !record;
    $('btn-search').disabled = !record;
    $('btn-redownload').hidden = !record;
    $('btn-print-lot').disabled = !record;
    $('btn-print-ticket').disabled = !record;
    $('btn-delete-result').hidden = !isLocked();
    $('btn-wipe-all').hidden = !isLocked();
  }

  function renderDraw() {
    const btn = $('btn-draw');
    let hint = '';
    if (isLocked()) hint = 'Le tirage est fait : aucun nouveau tirage possible sur cet ordinateur.';
    else if (!E.cryptoAvailable()) hint = 'Ce navigateur ne fournit pas de générateur aléatoire sécurisé (crypto.getRandomValues) : tirage impossible. Utilisez un navigateur récent.';
    else if (!prepReady()) hint = 'Importez des lots et des achats valides (onglet 1) pour activer le tirage.';
    btn.disabled = drawing || isLocked() || !prepReady() || !E.cryptoAvailable();
    $('draw-hint').textContent = hint;
  }

  function render() {
    $('demo-banner').hidden = !showsDemo();
    const locked = isLocked();
    ['btn-import-lots', 'btn-import-achats', 'btn-demo'].forEach(id => { $(id).disabled = locked; });
    $('lock-note').hidden = !locked;
    $('btn-clear-demo').hidden = !showsDemo();
    $('btn-del-lots').hidden = locked || !prep.lots;
    $('btn-del-achats').hidden = locked || !prep.achats;
    renderImportStatus();
    renderRecap('recap-prep');
    renderRecap('recap-tirage');
    renderPreviews();
    renderDraw();
    renderBar();
  }

  function showTab(name) {
    currentTab = name;
    ['prep', 'tirage', 'bar'].forEach(t => {
      $('tab-' + t).hidden = t !== name;
      $('tabbtn-' + t).setAttribute('aria-selected', String(t === name));
    });
    if (name === 'bar' && record) $('search').focus();
  }

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- Préparation ----------

  function readFile(input, cb) {
    const f = input.files && input.files[0];
    input.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => cb(String(reader.result), f.name);
    reader.onerror = () => cb(null, f.name, reader.error);
    reader.readAsText(f, 'UTF-8');
  }

  // Un import réel retire les données de démonstration pour ne jamais mélanger les deux.
  function leaveDemoIfNeeded() {
    if (!prep.demo) return null;
    prep = { lots: null, achats: null, demo: false };
    return msgBox('info', 'Les données de démonstration ont été retirées.');
  }

  function handleImport(kind, text, fileName, err) {
    const msgId = kind === 'lots' ? 'msg-lots' : 'msg-achats';
    const label = kind === 'lots' ? 'Lots' : 'Achats';
    if (isLocked()) return;
    if (text === null) {
      $(msgId).dataset.keep = '1';
      fill(msgId, msgBox('error', label + ' : lecture du fichier « ' + fileName + ' » impossible.', [err ? String(err) : '']));
      render();
      return;
    }
    const res = kind === 'lots' ? E.parseLots(text) : E.parseAchats(text);
    if (!res.ok) {
      $(msgId).dataset.keep = '1';
      fill(msgId, msgBox('error', label + ' : fichier « ' + fileName + ' » refusé. L\'import précédent est conservé.',
        fmtErrors(res.errors).concat(res.infos)));
      render();
      return;
    }
    const demoNote = leaveDemoIfNeeded();
    if (kind === 'lots') prep.lots = { fileName, lots: res.lots, infos: res.infos };
    else prep.achats = { fileName, achats: res.achats, infos: res.infos };
    savePrep();
    delete $('msg-lots').dataset.keep;
    delete $('msg-achats').dataset.keep;
    render();
    if (demoNote) $(msgId).prepend(demoNote);
  }

  $('btn-import-lots').addEventListener('click', () => $('file-lots').click());
  $('btn-import-achats').addEventListener('click', () => $('file-achats').click());
  $('file-lots').addEventListener('change', e => readFile(e.target, (t, n, err) => handleImport('lots', t, n, err)));
  $('file-achats').addEventListener('change', e => readFile(e.target, (t, n, err) => handleImport('achats', t, n, err)));

  $('btn-modeles').addEventListener('click', () => {
    download('lots_modele.csv', '﻿' + E.DEMO_LOTS_CSV.replace(/\n/g, '\r\n'));
    setTimeout(() => download('achats_modele.csv', '﻿' + E.DEMO_ACHATS_CSV.replace(/\n/g, '\r\n')), 400);
  });

  function loadDemo() {
    const l = E.parseLots(E.DEMO_LOTS_CSV);
    const a = E.parseAchats(E.DEMO_ACHATS_CSV);
    prep = {
      lots: { fileName: 'DÉMONSTRATION', lots: l.lots, infos: l.infos },
      achats: { fileName: 'DÉMONSTRATION', achats: a.achats, infos: a.infos },
      demo: true
    };
    delete $('msg-lots').dataset.keep;
    delete $('msg-achats').dataset.keep;
    savePrep();
    render();
  }

  $('btn-demo').addEventListener('click', () => {
    if (isLocked()) return;
    if ((prep.lots || prep.achats) && !prep.demo) {
      openDialog({
        title: 'Remplacer les données importées ?',
        body: [el('p', { text: 'Les lots et achats importés seront remplacés par des données de DÉMONSTRATION.' })],
        okLabel: 'Charger la démo',
        onOk: loadDemo
      });
    } else loadDemo();
  });

  $('btn-clear-demo').addEventListener('click', () => {
    if (record && record.demo) {
      const r = storageRemove(KEY_RECORD);
      if (!r.ok) alertStorage('effacement du tirage', r.error);
      setRecord(null);
      saveFailed = false;
      drawing = false;
    }
    if (prep.demo) {
      prep = { lots: null, achats: null, demo: false };
      const r = storageRemove(KEY_PREP);
      if (!r.ok) alertStorage('effacement des imports', r.error);
    }
    render();
    showTab('prep');
  });

  // ---------- Tirage ----------

  $('btn-draw').addEventListener('click', () => {
    if (drawing || isLocked() || !prepReady()) return;
    const s = E.summarize(prep.lots.lots, prep.achats.achats);
    const li = t => el('li', { text: t });
    openDialog({
      title: 'Confirmer le tirage au sort',
      body: [
        prep.demo ? el('p', { class: 'msg error', text: 'DÉMONSTRATION — résultat non valable' }) : null,
        el('ul', null, li(s.P + ' acheteurs (P)'), li(s.T + ' tickets (T)'), li(s.L + ' lots (L)'), li(s.K + ' lots attribués (K)')),
        el('p', { class: 'mode', text: E.modeText(s.mode, s.P, s.L) }),
        s.nonAttribues ? el('p', { text: s.nonAttribues + ' lot(s) resteront non attribués.' }) : null,
        el('p', { text: 'Le tirage est définitif. Le fichier CSV du résultat sera téléchargé automatiquement.' })
      ].filter(Boolean),
      okLabel: 'Confirmer et tirer au sort',
      onOk: performDraw
    });
  });

  function performDraw() {
    if (drawing) return;
    drawing = true;
    $('btn-draw').disabled = true;
    const status = clear($('draw-status'));

    const existing = storageRead(KEY_RECORD);
    if (!existing.ok) alertStorage('vérification d\'un tirage existant', existing.error);
    else if (existing.value) {
      loadRecord();
      status.appendChild(msgBox('error', 'Un tirage existe déjà sur cet ordinateur (autre onglet ?) : aucun nouveau tirage. Le tirage existant est affiché.'));
      render();
      return;
    }

    let rec;
    try {
      rec = E.createRecord({ lots: prep.lots.lots, achats: prep.achats.achats, demo: prep.demo });
    } catch (e) {
      drawing = false;
      status.appendChild(msgBox('error', 'Tirage impossible : ' + e.message));
      render();
      return;
    }
    setRecord(rec);
    const w = storageWrite(KEY_RECORD, rec);
    saveFailed = !w.ok;
    if (!w.ok) alertStorage('enregistrement du tirage', w.error);
    downloadResult();
    status.appendChild(msgBox('ok', 'Tirage effectué. Le fichier « ' + E.resultFileName(rec) + ' » a été téléchargé : gardez-le, c\'est la sauvegarde.'));
    render();
    showTab('bar');
  }

  // ---------- Bar ----------

  $('search-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!index) return;
    const res = E.search(index, $('search').value);
    const list = clear($('search-results'));
    clear($('search-message'));
    if (!res.ok) {
      $('search-summary').textContent = '';
      $('search-message').appendChild(msgBox('error', res.message));
    } else {
      res.lignes.forEach(l => list.appendChild(el('li', {
        class: l.statut === 'GAGNANT' ? 'win' : l.statut === 'NON_ENREGISTRE' ? 'absent' : 'lose',
        text: l.texte
      })));
      $('search-summary').textContent = res.consultes + ' ticket(s) consulté(s), ' + res.gagnants + ' gagnant(s)';
      if (res.tronque) $('search-message').appendChild(msgBox('info', res.message));
    }
    $('search').select();
  });

  $('btn-redownload').addEventListener('click', downloadResult);

  $('btn-import-result').addEventListener('click', () => $('file-result').click());
  $('file-result').addEventListener('change', e => readFile(e.target, (text, name, err) => {
    if (text === null) { fill('msg-result', msgBox('error', 'Lecture du fichier « ' + name + ' » impossible.', [String(err)])); return; }
    const res = E.importResultCSV(text);
    if (!res.ok) {
      fill('msg-result', msgBox('error', 'Résultat « ' + name + ' » refusé : rien n\'a été modifié.', fmtErrors(res.errors)));
      return;
    }
    const apply = () => {
      setRecord(res.record);
      drawing = false;
      const w = storageWrite(KEY_RECORD, res.record);
      saveFailed = !w.ok;
      if (!w.ok) alertStorage('enregistrement du résultat importé', w.error);
      fill('msg-result', msgBox('ok', 'Résultat « ' + name + ' » importé : cet ordinateur est en consultation.', res.infos));
      render();
      showTab('bar');
    };
    const stored = storageRead(KEY_RECORD);
    const local = record || recordCorrupt || (stored.ok && stored.value);
    if (local) {
      openDialog({
        title: 'Remplacer le tirage de cet ordinateur ?',
        body: [
          el('p', { text: 'Tirage actuel : ' + (record ? record.tirage_id : 'illisible') + '.' }),
          el('p', { text: 'Tirage importé : ' + res.record.tirage_id + '.' }),
          el('p', { text: 'Le tirage actuel ne sera plus consultable ici. Vérifiez que son CSV est sauvegardé.' })
        ],
        okLabel: 'Remplacer',
        danger: true,
        onOk: apply
      });
    } else apply();
  }));

  // Supprime le résultat (et, si alsoPrep, les imports) puis revient à la Préparation.
  function eraseResult(alsoPrep) {
    const r = storageRemove(KEY_RECORD);
    if (!r.ok) alertStorage('effacement du tirage', r.error);
    if (alsoPrep) {
      const p = storageRemove(KEY_PREP);
      if (!p.ok) alertStorage('effacement des imports', p.error);
      prep = { lots: null, achats: null, demo: false };
      delete $('msg-lots').dataset.keep;
      delete $('msg-achats').dataset.keep;
    }
    setRecord(null);
    saveFailed = false;
    drawing = false;
    clear($('search-results'));
    $('search-summary').textContent = '';
    clear($('search-message'));
    clear($('draw-status'));
    render();
    showTab('prep');
  }

  function confirmErase(title, okLabel, alsoPrep) {
    openDialog({
      title,
      body: [
        el('p', { text: 'Vérifiez que le CSV du résultat a bien été téléchargé : ce tirage sera perdu sur cet ordinateur.' }),
        el('p', { text: 'Tapez EFFACER pour confirmer.' })
      ],
      okLabel,
      danger: true,
      requireText: 'EFFACER',
      onOk: () => eraseResult(alsoPrep)
    });
  }

  $('btn-delete-result').addEventListener('click', () => confirmErase('Supprimer le résultat', 'Supprimer le résultat', false));
  $('btn-wipe-all').addEventListener('click', () => confirmErase('Tout effacer (lots, achats et résultat)', 'Tout effacer', true));

  function deletePrep(kind) {
    if (isLocked()) return;
    openDialog({
      title: kind === 'lots' ? 'Supprimer la liste de lots ?' : 'Supprimer les achats ?',
      body: [el('p', { text: kind === 'lots' ? 'Les lots importés seront retirés de cet ordinateur.' : 'Les achats importés seront retirés de cet ordinateur.' })],
      okLabel: 'Oui, supprimer',
      danger: true,
      onOk: () => {
        prep[kind] = null;
        if (!prep.lots && !prep.achats) prep.demo = false;
        delete $(kind === 'lots' ? 'msg-lots' : 'msg-achats').dataset.keep;
        savePrep();
        render();
      }
    });
  }

  $('btn-del-lots').addEventListener('click', () => deletePrep('lots'));
  $('btn-del-achats').addEventListener('click', () => deletePrep('achats'));

  function printList(byTicket) {
    if (!record) return;
    const area = clear($('print-area'));
    if (record.demo) area.appendChild(el('p', { class: 'print-demo', text: 'DÉMONSTRATION — résultat non valable' }));
    area.appendChild(el('h2', { text: 'Tombola des 10 ans du NAM-IP — liste des gagnants (' + (byTicket ? 'par ticket' : 'par lot') + ')' }));
    area.appendChild(el('p', { text: 'Tirage ' + record.tirage_id + ' du ' + E.displayDate(record) }));
    const nameOf = t => index.buyers.get(index.owner.get(t)).nom;
    let rows;
    if (byTicket) {
      rows = record.attributions.slice().sort((a, b) => a[0] - b[0])
        .map(p => [p[0], nameOf(p[0]), p[1], index.lotsById.get(p[1]).description, '☐']);
      area.appendChild(table(['Ticket', 'Nom', 'Lot', 'Description', 'Remis'], rows));
    } else {
      rows = record.lots.slice().sort((a, b) => a.lot_id - b.lot_id).map(l => {
        const t = index.lotWinner.get(l.lot_id);
        return t === undefined ? [l.lot_id, l.description, '—', 'non attribué', ''] : [l.lot_id, l.description, t, nameOf(t), '☐'];
      });
      area.appendChild(table(['Lot', 'Description', 'Ticket gagnant', 'Nom', 'Remis'], rows));
    }
    window.print();
  }

  $('btn-print-lot').addEventListener('click', () => printList(false));
  $('btn-print-ticket').addEventListener('click', () => printList(true));

  // Un tirage fait dans un autre onglet verrouille aussi celui-ci.
  window.addEventListener('storage', e => {
    if (e.key !== KEY_RECORD && e.key !== null) return;
    loadRecord();
    if (!record && !recordCorrupt) drawing = false;
    render();
    if (record) showTab('bar');
  });

  // ---------- Démarrage ----------

  loadPrep();
  loadRecord();
  render();
  showTab(isLocked() ? 'bar' : 'prep');
})();
