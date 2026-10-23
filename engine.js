/*
 * Moteur de la tombola des 10 ans du NAM-IP.
 * Pur : aucun accès au DOM, aucun appel réseau. Utilisable dans le navigateur
 * (globalThis.TombolaEngine) et sous Node (module.exports) pour les tests.
 */
(function () {
  'use strict';

  const ALGO_VERSION = '1';
  const FORMAT = 'tombola-nam-ip';
  const MODE_GARANTIE = 'GARANTIE_ACTIVE';
  const MODE_CLASSIQUE = 'GARANTIE_DESACTIVEE';
  const DEMO_VALUE = 'DÉMONSTRATION — résultat non valable';
  const NON_DEMO_VALUE = 'NON';
  // Garde-fou mémoire : une plage aberrante (ex. 1–1000000000) ne doit pas figer le navigateur.
  const MAX_TICKETS = 1000000;
  const SEARCH_LIMIT = 500;

  const LOTS_HEADER = ['lot_id', 'description'];
  const ACHATS_HEADER = ['acheteur_id', 'nom', 'ticket_debut', 'ticket_fin'];
  const RESULT_HEADER = ['tirage_id', 'date_tirage', 'mode', 'version_algo', 'demo', 'type',
    'ticket', 'acheteur_id', 'nom', 'lot_id', 'lot_description', 'remis'];

  const DEMO_LOTS_CSV = [
    'lot_id;description',
    '1;DÉMONSTRATION - Visite guidée du musée pour 4 personnes (lot fictif)',
    '2;DÉMONSTRATION - Bon d\'achat de 25 € à la boutique (lot fictif)',
    '3;DÉMONSTRATION - Livre « 10 ans du musée » (lot fictif)',
    '4;DÉMONSTRATION - Session quiz pour 5 joueurs (lot fictif)',
    '5;"DÉMONSTRATION - Coffret ""Radio ; TSF"" (lot fictif)"',
    '6;DÉMONSTRATION - Affiche ancienne encadrée (lot fictif)',
    '7;DÉMONSTRATION - Abonnement annuel au musée (lot fictif)',
    '8;DÉMONSTRATION - Repas pour deux (lot fictif)',
    '9;DÉMONSTRATION - Casque audio (lot fictif)',
    '10;DÉMONSTRATION - Maquette d\'ordinateur ancien (lot fictif)',
    '11;DÉMONSTRATION - Tasse et carnet du musée (lot fictif)',
    '12;DÉMONSTRATION - Atelier découverte pour enfants (lot fictif)',
    ''
  ].join('\n');

  const DEMO_ACHATS_CSV = [
    'acheteur_id;nom;ticket_debut;ticket_fin',
    'D001;DÉMO Alice;1;5',
    'D002;DÉMO Bernard;6;10',
    'D003;DÉMO Chloé;11;11',
    'D002;DÉMO Bernard;14;18',
    'D004;DÉMO David;19;33',
    'D005;DÉMO Alice;34;36',
    'D006;DÉMO Émile;40;44',
    'D007;DÉMO Farida;45;45',
    'D008;DÉMO Gaston;46;50',
    ''
  ].join('\n');

  // ---------- Hasard ----------

  function cryptoAvailable() {
    const c = globalThis.crypto;
    return !!(c && typeof c.getRandomValues === 'function');
  }

  // Source de hasard réelle : uniquement crypto.getRandomValues, sans solution de repli.
  function cryptoRng() {
    if (!cryptoAvailable()) {
      throw new Error('Générateur aléatoire sécurisé (crypto.getRandomValues) indisponible sur ce navigateur : tirage impossible.');
    }
    const buf = new Uint32Array(256);
    let pos = buf.length;
    return function () {
      if (pos >= buf.length) {
        globalThis.crypto.getRandomValues(buf);
        pos = 0;
      }
      return buf[pos++];
    };
  }

  // Entier uniforme dans [0, n) par rejet : on écarte la fin de plage qui créerait un biais modulo.
  function randomInt(n, rng) {
    if (!Number.isSafeInteger(n) || n < 1 || n > 0x100000000) throw new Error('Borne aléatoire invalide : ' + n);
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const x = rng() >>> 0;
      if (x < limit) return x % n;
    }
  }

  function shuffle(array, rng) {
    const a = array.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1, rng);
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  // ---------- CSV ----------

  function parseCSV(text) {
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const records = [];
    let rec = [];
    let field = '';
    let inQuotes = false;
    let line = 1;
    let recLine = 1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
        } else {
          if (c === '\n') line++;
          field += c;
        }
        continue;
      }
      if (c === '"' && field === '') { inQuotes = true; continue; }
      if (c === ';') { rec.push(field); field = ''; continue; }
      if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        rec.push(field);
        records.push({ line: recLine, fields: rec });
        rec = [];
        field = '';
        line++;
        recLine = line;
        continue;
      }
      field += c;
    }
    if (inQuotes) {
      return { records: [], error: { line: recLine, message: 'Guillemet ouvert jamais refermé (enregistrement commencé ligne ' + recLine + ').' } };
    }
    if (field !== '' || rec.length) { rec.push(field); records.push({ line: recLine, fields: rec }); }
    return { records: records.filter(r => r.fields.some(f => f.trim() !== '')), error: null };
  }

  // Lit un tableau CSV avec en-têtes obligatoires (ordre libre, casse ignorée).
  function readTable(text, required) {
    const parsed = parseCSV(text);
    if (parsed.error) return { rows: [], errors: [parsed.error] };
    if (parsed.records.length === 0) return { rows: [], errors: [{ line: null, message: 'Fichier vide.' }] };
    const head = parsed.records[0];
    const names = head.fields.map(f => f.trim().toLowerCase());
    const idx = {};
    const errors = [];
    required.forEach(n => {
      const i = names.indexOf(n);
      if (i < 0) {
        errors.push({ line: head.line, message: 'En-tête manquant : « ' + n + ' ». En-têtes lus : « ' + names.join(' | ') +
          ' ». Attendu : ' + required.join(';') + ' (séparateur point-virgule).' });
      } else idx[n] = i;
    });
    if (errors.length) return { rows: [], errors };
    const rows = parsed.records.slice(1).map(r => {
      const row = { line: r.line };
      required.forEach(n => { row[n] = r.fields[idx[n]] == null ? '' : r.fields[idx[n]]; });
      return row;
    });
    return { rows, errors };
  }

  function parseNonNegInt(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '') return { error: 'vide' };
    if (/^-\s*\d+$/.test(s)) return { error: 'négatif' };
    if (!/^\d+$/.test(s)) return { error: 'pas un nombre entier' };
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return { error: 'trop grand' };
    return { value: n };
  }

  function str(v) { return String(v == null ? '' : v).trim(); }

  function fmtRange(a, b) { return a === b ? String(a) : a + '–' + b; }

  // ---------- Validation des imports ----------

  function validateLotRows(rows) {
    const errors = [];
    const lots = [];
    const seen = new Map();
    rows.forEach(r => {
      const before = errors.length;
      const desc = str(r.description);
      const p = parseNonNegInt(r.lot_id);
      let id = null;
      if (p.error === 'vide') errors.push({ line: r.line, message: 'Champ « lot_id » vide.' });
      else if (p.error) errors.push({ line: r.line, message: 'lot_id « ' + str(r.lot_id) + ' » invalide (' + p.error + ').' });
      else if (p.value < 1) errors.push({ line: r.line, message: 'lot_id ' + p.value + ' invalide : il doit être supérieur ou égal à 1.' });
      else id = p.value;
      if (desc === '') errors.push({ line: r.line, message: 'Champ « description » vide.' });
      if (id !== null) {
        if (seen.has(id)) errors.push({ line: r.line, message: 'lot_id ' + id + ' en double (déjà présent ligne ' + seen.get(id) + ').' });
        else seen.set(id, r.line);
      }
      if (errors.length === before) lots.push({ lot_id: id, description: desc });
    });
    if (rows.length === 0) errors.push({ line: null, message: 'Aucun lot dans le fichier.' });
    return { ok: errors.length === 0, lots, errors, infos: [rows.length + ' ligne(s) de lots lue(s).'] };
  }

  function computeGaps(sortedTickets) {
    const gaps = [];
    for (let i = 1; i < sortedTickets.length; i++) {
      if (sortedTickets[i] - sortedTickets[i - 1] > 1) gaps.push([sortedTickets[i - 1] + 1, sortedTickets[i] - 1]);
    }
    return gaps;
  }

  function validateAchatRows(rows) {
    const errors = [];
    const valid = [];
    const names = new Map();
    rows.forEach(r => {
      const before = errors.length;
      const id = str(r.acheteur_id);
      const nom = str(r.nom);
      if (id === '') errors.push({ line: r.line, message: 'Champ « acheteur_id » vide.' });
      if (nom === '') errors.push({ line: r.line, message: 'Champ « nom » vide.' });
      const bounds = {};
      ['ticket_debut', 'ticket_fin'].forEach(k => {
        const p = parseNonNegInt(r[k]);
        if (p.error === 'vide') errors.push({ line: r.line, message: 'Champ « ' + k + ' » vide.' });
        else if (p.error) errors.push({ line: r.line, message: k + ' « ' + str(r[k]) + ' » invalide (' + p.error + ').' });
        else bounds[k] = p.value;
      });
      if (bounds.ticket_debut !== undefined && bounds.ticket_fin !== undefined && bounds.ticket_debut > bounds.ticket_fin) {
        errors.push({ line: r.line, message: 'ticket_debut (' + bounds.ticket_debut + ') supérieur à ticket_fin (' + bounds.ticket_fin + ').' });
      }
      if (id !== '' && nom !== '') {
        const known = names.get(id);
        if (!known) names.set(id, { nom, line: r.line });
        else if (known.nom !== nom) {
          errors.push({ line: r.line, message: 'acheteur_id « ' + id + ' » avec deux noms différents : « ' + known.nom +
            ' » (ligne ' + known.line + ') et « ' + nom + ' » (ligne ' + r.line + ').' });
        }
      }
      if (errors.length === before) {
        valid.push({ acheteur_id: id, nom, debut: bounds.ticket_debut, fin: bounds.ticket_fin, line: r.line });
      }
    });
    if (rows.length === 0) errors.push({ line: null, message: 'Aucun achat dans le fichier.' });

    let total = 0;
    valid.forEach(a => { total += a.fin - a.debut + 1; });
    let gaps = [];
    if (total > MAX_TICKETS) {
      errors.push({ line: null, message: 'Le fichier décrit ' + total + ' tickets (maximum ' + MAX_TICKETS + ') : une plage est probablement erronée.' });
    } else {
      const owner = new Map();
      const dups = [];
      valid.forEach(a => {
        for (let t = a.debut; t <= a.fin; t++) {
          if (owner.has(t)) dups.push({ ticket: t, first: owner.get(t), second: a.line });
          else owner.set(t, a.line);
        }
      });
      dups.sort((x, y) => x.ticket - y.ticket);
      const groups = [];
      dups.forEach(d => {
        const g = groups[groups.length - 1];
        if (g && g.first === d.first && g.second === d.second && g.to + 1 === d.ticket) g.to = d.ticket;
        else groups.push({ from: d.ticket, to: d.ticket, first: d.first, second: d.second });
      });
      groups.forEach(g => {
        const what = g.from === g.to ? 'Ticket ' + g.from + ' en double' : 'Tickets ' + g.from + ' à ' + g.to + ' en double';
        errors.push({ line: g.second, message: what + ' : déjà présent ligne ' + g.first + '.' });
      });
      gaps = computeGaps(Array.from(owner.keys()).sort((x, y) => x - y));
    }

    const infos = [rows.length + ' ligne(s) d\'achats lue(s).'];
    if (gaps.length) {
      const shown = gaps.slice(0, 50).map(g => fmtRange(g[0], g[1])).join(', ');
      infos.push('Trous dans la numérotation (tickets non vendus, exclus du tirage) : ' + shown +
        (gaps.length > 50 ? ' … et ' + (gaps.length - 50) + ' autre(s) trou(s).' : '.'));
    }
    const achats = valid.map(a => ({ acheteur_id: a.acheteur_id, nom: a.nom, debut: a.debut, fin: a.fin }));
    return { ok: errors.length === 0, achats, errors, infos, gaps };
  }

  function parseLots(text) {
    const t = readTable(text, LOTS_HEADER);
    if (t.errors.length) return { ok: false, lots: [], errors: t.errors, infos: [] };
    return validateLotRows(t.rows);
  }

  function parseAchats(text) {
    const t = readTable(text, ACHATS_HEADER);
    if (t.errors.length) return { ok: false, achats: [], errors: t.errors, infos: [], gaps: [] };
    return validateAchatRows(t.rows);
  }

  // Revalide des données déjà typées (instantané stocké ou reconstitué).
  function checkData(lots, achats) {
    const l = validateLotRows((lots || []).map((x, i) => ({ line: i + 1, lot_id: x.lot_id, description: x.description })));
    const a = validateAchatRows((achats || []).map((x, i) => ({
      line: i + 1, acheteur_id: x.acheteur_id, nom: x.nom, ticket_debut: x.debut, ticket_fin: x.fin
    })));
    return l.errors.map(e => 'Lots : ' + e.message).concat(a.errors.map(e => 'Achats : ' + e.message));
  }

  // ---------- Registre et récapitulatif ----------

  function buildRegistry(achats) {
    const buyers = new Map();
    const owner = new Map();
    achats.forEach(a => {
      let b = buyers.get(a.acheteur_id);
      if (!b) { b = { acheteur_id: a.acheteur_id, nom: a.nom, tickets: [] }; buyers.set(a.acheteur_id, b); }
      for (let t = a.debut; t <= a.fin; t++) { b.tickets.push(t); owner.set(t, a.acheteur_id); }
    });
    buyers.forEach(b => b.tickets.sort((x, y) => x - y));
    const tickets = Array.from(owner.keys()).sort((x, y) => x - y);
    return { buyers, owner, tickets };
  }

  function summarize(lots, achats) {
    const reg = buildRegistry(achats);
    const P = reg.buyers.size;
    const T = reg.tickets.length;
    const L = lots.length;
    const K = Math.min(T, L);
    const mode = P > 0 && P <= L ? MODE_GARANTIE : MODE_CLASSIQUE;
    return { P, T, L, K, mode, nonAttribues: L - K };
  }

  function modeText(mode, P, L) {
    if (mode === MODE_GARANTIE) return 'Garantie active : chaque acheteur gagne au moins un lot';
    return 'Garantie désactivée : plus d\'acheteurs (' + P + ') que de lots (' + L + '), tirage classique';
  }

  // ---------- Tirage ----------

  // rng est injectable pour les tests uniquement ; sans rng, crypto.getRandomValues est obligatoire.
  function draw(lots, achats, rng) {
    rng = rng || cryptoRng();
    const reg = buildRegistry(achats);
    const P = reg.buyers.size;
    const T = reg.tickets.length;
    const L = lots.length;
    if (L === 0) throw new Error('Aucun lot importé : tirage impossible.');
    if (T === 0) throw new Error('Aucun ticket importé : tirage impossible.');
    const K = Math.min(T, L);
    const attributions = [];
    let mode;
    if (P <= L) {
      mode = MODE_GARANTIE;
      const lotIds = shuffle(lots.map(l => l.lot_id), rng);
      const order = shuffle(Array.from(reg.buyers.keys()), rng);
      const chosen = new Set();
      order.forEach((id, i) => {
        const ts = reg.buyers.get(id).tickets;
        const t = ts[randomInt(ts.length, rng)];
        chosen.add(t);
        attributions.push([t, lotIds[i]]);
      });
      const rest = shuffle(reg.tickets.filter(t => !chosen.has(t)), rng);
      for (let j = 0; attributions.length < K; j++) attributions.push([rest[j], lotIds[attributions.length]]);
    } else {
      mode = MODE_CLASSIQUE;
      const ts = shuffle(reg.tickets, rng);
      const lotIds = shuffle(lots.map(l => l.lot_id), rng);
      for (let i = 0; i < K; i++) attributions.push([ts[i], lotIds[i]]);
    }
    attributions.sort((x, y) => x[0] - y[0]);
    return { mode, attributions };
  }

  function createRecord(opts) {
    const rng = opts.rng || cryptoRng();
    const lots = opts.lots.map(l => ({ lot_id: l.lot_id, description: l.description }));
    const achats = opts.achats.map(a => ({ acheteur_id: a.acheteur_id, nom: a.nom, debut: a.debut, fin: a.fin }));
    const errs = checkData(lots, achats);
    if (errs.length) throw new Error('Données invalides : ' + errs.join(' '));
    const res = draw(lots, achats, rng);
    let id = '';
    for (let i = 0; i < 2; i++) id += (rng() >>> 0).toString(16).padStart(8, '0');
    return {
      format: FORMAT,
      version_algo: ALGO_VERSION,
      tirage_id: (opts.demo ? 'DEMO-' : '') + id,
      date_tirage: (opts.now || new Date()).toISOString(),
      mode: res.mode,
      demo: !!opts.demo,
      origine: 'tirage',
      lots,
      achats,
      attributions: res.attributions
    };
  }

  // Contrôle complet d'un résultat (stocké, importé ou fraîchement tiré). Renvoie la liste des erreurs.
  function checkRecord(rec) {
    if (!rec || typeof rec !== 'object') return ['Résultat absent ou illisible.'];
    const errs = [];
    if (rec.format !== FORMAT) errs.push('Format de résultat inconnu.');
    if (rec.version_algo !== ALGO_VERSION) errs.push('Version d\'algorithme « ' + rec.version_algo + ' » inconnue (attendu ' + ALGO_VERSION + ').');
    if (typeof rec.tirage_id !== 'string' || rec.tirage_id === '') errs.push('tirage_id manquant.');
    if (typeof rec.date_tirage !== 'string' || isNaN(Date.parse(rec.date_tirage))) errs.push('date_tirage invalide.');
    if (rec.mode !== MODE_GARANTIE && rec.mode !== MODE_CLASSIQUE) errs.push('Mode « ' + rec.mode + ' » inconnu.');
    if (!Array.isArray(rec.lots) || !Array.isArray(rec.achats) || !Array.isArray(rec.attributions)) {
      errs.push('Structure du résultat incomplète.');
      return errs;
    }
    const dataErrs = checkData(rec.lots, rec.achats);
    if (dataErrs.length) return errs.concat(dataErrs);
    const s = summarize(rec.lots, rec.achats);
    if (s.T === 0 || s.L === 0) errs.push('Résultat sans ticket ou sans lot.');
    if (rec.mode !== s.mode) errs.push('Mode incohérent avec le nombre d\'acheteurs (' + s.P + ') et de lots (' + s.L + ').');
    const reg = buildRegistry(rec.achats);
    const lotIds = new Set(rec.lots.map(l => l.lot_id));
    const seenT = new Set();
    const seenL = new Set();
    const winners = new Set();
    rec.attributions.forEach(pair => {
      const t = Array.isArray(pair) ? pair[0] : undefined;
      const l = Array.isArray(pair) ? pair[1] : undefined;
      if (!reg.owner.has(t)) errs.push('Ticket gagnant ' + t + ' absent du registre des tickets vendus.');
      else winners.add(reg.owner.get(t));
      if (!lotIds.has(l)) errs.push('Lot ' + l + ' attribué mais inconnu.');
      if (seenT.has(t)) errs.push('Ticket ' + t + ' gagnant plusieurs fois.');
      if (seenL.has(l)) errs.push('Lot ' + l + ' attribué plusieurs fois.');
      seenT.add(t);
      seenL.add(l);
    });
    if (rec.attributions.length !== s.K) errs.push(rec.attributions.length + ' attribution(s) au lieu de ' + s.K + '.');
    if (rec.mode === MODE_GARANTIE) {
      reg.buyers.forEach(b => { if (!winners.has(b.acheteur_id)) errs.push('Garantie active mais l\'acheteur ' + b.acheteur_id + ' n\'a rien gagné.'); });
    }
    return errs;
  }

  function buildIndex(rec) {
    const reg = buildRegistry(rec.achats);
    const lotsById = new Map(rec.lots.map(l => [l.lot_id, l]));
    const wins = new Map(rec.attributions.map(p => [p[0], p[1]]));
    const lotWinner = new Map(rec.attributions.map(p => [p[1], p[0]]));
    const unassigned = rec.lots.filter(l => !lotWinner.has(l.lot_id)).sort((a, b) => a.lot_id - b.lot_id);
    return { buyers: reg.buyers, owner: reg.owner, tickets: reg.tickets, lotsById, wins, lotWinner, unassigned };
  }

  // ---------- CSV de résultat ----------

  // Anti-formule : préfixe d'apostrophe. L'apostrophe elle-même est préfixée pour que le réimport soit exact.
  const RISKY = /^[=+\-@\t\r']/;

  function protect(s) { return RISKY.test(s) ? '\'' + s : s; }

  function unprotect(s) { return s.length > 1 && s[0] === '\'' && RISKY.test(s.slice(1)) ? s.slice(1) : s; }

  function csvCell(v) {
    const s = protect(String(v == null ? '' : v));
    return /[;"\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportResultCSV(rec) {
    const idx = buildIndex(rec);
    const meta = [rec.tirage_id, rec.date_tirage, rec.mode, rec.version_algo, rec.demo ? DEMO_VALUE : NON_DEMO_VALUE];
    const rows = [RESULT_HEADER];
    idx.tickets.forEach(t => {
      const b = idx.buyers.get(idx.owner.get(t));
      const lot = idx.wins.get(t);
      if (lot !== undefined) rows.push(meta.concat(['GAGNANT', t, b.acheteur_id, b.nom, lot, idx.lotsById.get(lot).description, '']));
      else rows.push(meta.concat(['NON_GAGNANT', t, b.acheteur_id, b.nom, '', '', '']));
    });
    idx.unassigned.forEach(l => rows.push(meta.concat(['LOT_NON_ATTRIBUE', '', '', '', l.lot_id, l.description, ''])));
    return '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function resultFileName(rec) {
    const d = new Date(rec.date_tirage);
    const name = 'tombola_resultat_' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds()) + '.csv';
    return rec.demo ? 'DEMO_' + name : name;
  }

  function importResultCSV(text) {
    const t = readTable(text, RESULT_HEADER);
    if (t.errors.length) return { ok: false, errors: t.errors };
    const errors = [];
    if (t.rows.length === 0) return { ok: false, errors: [{ line: null, message: 'Aucune ligne de résultat.' }] };
    const rows = t.rows.map(r => {
      const o = { line: r.line };
      RESULT_HEADER.forEach(k => { o[k] = unprotect(String(r[k])).trim(); });
      return o;
    });
    const metaKeys = ['tirage_id', 'date_tirage', 'mode', 'version_algo', 'demo'];
    const first = rows[0];
    rows.forEach(r => metaKeys.forEach(k => {
      if (r[k] !== first[k]) {
        errors.push({ line: r.line, message: k + ' « ' + r[k] + ' » différent de la première ligne (« ' + first[k] + ' ») : un fichier ne doit contenir qu\'un seul tirage.' });
      }
    }));
    if (first.demo !== DEMO_VALUE && first.demo !== NON_DEMO_VALUE) {
      errors.push({ line: first.line, message: 'Colonne demo « ' + first.demo + ' » non reconnue.' });
    }
    const lots = new Map();
    const tickets = new Map();
    const names = new Map();
    const attributions = [];
    function need(r, k) { if (r[k] === '') errors.push({ line: r.line, message: 'Ligne ' + r.type + ' : champ « ' + k + ' » vide.' }); }
    function mustBeEmpty(r, k) { if (r[k] !== '') errors.push({ line: r.line, message: 'Ligne ' + r.type + ' : le champ « ' + k + ' » devrait être vide.' }); }
    function int(r, k, min) {
      const p = parseNonNegInt(r[k]);
      if (p.error) { if (r[k] !== '') errors.push({ line: r.line, message: k + ' « ' + r[k] + ' » invalide (' + p.error + ').' }); return null; }
      if (p.value < min) { errors.push({ line: r.line, message: k + ' ' + p.value + ' invalide.' }); return null; }
      return p.value;
    }
    rows.forEach(r => {
      const isTicket = r.type === 'GAGNANT' || r.type === 'NON_GAGNANT';
      const hasLot = r.type === 'GAGNANT' || r.type === 'LOT_NON_ATTRIBUE';
      if (!isTicket && !hasLot) { errors.push({ line: r.line, message: 'Type « ' + r.type + ' » inconnu.' }); return; }
      let ticket = null;
      let lotId = null;
      if (isTicket) {
        ['ticket', 'acheteur_id', 'nom'].forEach(k => need(r, k));
        ticket = int(r, 'ticket', 0);
        if (ticket !== null) {
          if (tickets.has(ticket)) errors.push({ line: r.line, message: 'Ticket ' + ticket + ' en double (déjà ligne ' + tickets.get(ticket).line + ').' });
          else tickets.set(ticket, { acheteur_id: r.acheteur_id, nom: r.nom, line: r.line });
        }
        if (r.acheteur_id !== '' && r.nom !== '') {
          const known = names.get(r.acheteur_id);
          if (!known) names.set(r.acheteur_id, { nom: r.nom, line: r.line });
          else if (known.nom !== r.nom) errors.push({ line: r.line, message: 'acheteur_id « ' + r.acheteur_id + ' » avec deux noms différents (voir ligne ' + known.line + ').' });
        }
      } else ['ticket', 'acheteur_id', 'nom'].forEach(k => mustBeEmpty(r, k));
      if (hasLot) {
        need(r, 'lot_id');
        need(r, 'lot_description');
        lotId = int(r, 'lot_id', 1);
        if (lotId !== null) {
          if (lots.has(lotId)) errors.push({ line: r.line, message: 'Lot ' + lotId + ' en double (déjà ligne ' + lots.get(lotId).line + ').' });
          else lots.set(lotId, { description: r.lot_description, line: r.line });
        }
      } else ['lot_id', 'lot_description'].forEach(k => mustBeEmpty(r, k));
      if (r.type === 'GAGNANT' && ticket !== null && lotId !== null) attributions.push([ticket, lotId]);
    });
    if (errors.length) return { ok: false, errors };

    // Reconstitue les plages : tickets consécutifs d'un même acheteur.
    const achats = [];
    Array.from(tickets.keys()).sort((a, b) => a - b).forEach(tk => {
      const o = tickets.get(tk);
      const last = achats[achats.length - 1];
      if (last && last.acheteur_id === o.acheteur_id && last.fin + 1 === tk) last.fin = tk;
      else achats.push({ acheteur_id: o.acheteur_id, nom: o.nom, debut: tk, fin: tk });
    });
    const rec = {
      format: FORMAT,
      version_algo: first.version_algo,
      tirage_id: first.tirage_id,
      date_tirage: first.date_tirage,
      mode: first.mode,
      demo: first.demo === DEMO_VALUE,
      origine: 'import',
      lots: Array.from(lots.keys()).sort((a, b) => a - b).map(id => ({ lot_id: id, description: lots.get(id).description })),
      achats,
      attributions: attributions.sort((a, b) => a[0] - b[0])
    };
    const recErrs = checkRecord(rec);
    if (recErrs.length) return { ok: false, errors: recErrs.map(m => ({ line: null, message: m })) };
    return { ok: true, record: rec, errors: [], infos: [rows.length + ' ligne(s) de résultat lue(s).'] };
  }

  // ---------- Recherche (vue Bar) ----------

  function parseQuery(q) {
    const s = String(q == null ? '' : q).trim();
    let m = /^(\d+)$/.exec(s);
    if (!m) m = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(s);
    if (!m) return { ok: false, message: 'Saisie non reconnue. Exemples : 7 ou 5-10.' };
    let from = Number(m[1]);
    let to = m[2] === undefined ? from : Number(m[2]);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return { ok: false, message: 'Numéro trop grand.' };
    if (from > to) { const x = from; from = to; to = x; }
    return { ok: true, from, to };
  }

  function search(index, query, limit) {
    limit = limit || SEARCH_LIMIT;
    const q = parseQuery(query);
    if (!q.ok) return q;
    const total = q.to - q.from + 1;
    const end = total > limit ? q.from + limit - 1 : q.to;
    const lignes = [];
    let gagnants = 0;
    for (let t = q.from; t <= end; t++) {
      if (!index.owner.has(t)) {
        lignes.push({ ticket: t, statut: 'NON_ENREGISTRE', texte: 'Ticket ' + t + ' — Non enregistré (absent de la liste des tickets vendus)' });
        continue;
      }
      const lot = index.wins.get(t);
      if (lot === undefined) {
        lignes.push({ ticket: t, statut: 'NON_GAGNANT', texte: 'Ticket ' + t + ' — Non gagnant' });
      } else {
        gagnants++;
        const desc = index.lotsById.get(lot).description;
        lignes.push({ ticket: t, statut: 'GAGNANT', lot_id: lot, description: desc, texte: 'Ticket ' + t + ' — GAGNANT — Lot n°' + lot + ' — ' + desc });
      }
    }
    return {
      ok: true, from: q.from, to: q.to, lignes, consultes: lignes.length, gagnants,
      tronque: total > limit,
      message: total > limit ? 'Plage de ' + total + ' tickets : seuls les ' + limit + ' premiers (' + q.from + ' à ' + end + ') sont affichés.' : ''
    };
  }

  const api = {
    ALGO_VERSION, MODE_GARANTIE, MODE_CLASSIQUE, DEMO_VALUE, MAX_TICKETS, SEARCH_LIMIT, RESULT_HEADER,
    DEMO_LOTS_CSV, DEMO_ACHATS_CSV,
    cryptoAvailable, cryptoRng, randomInt, shuffle,
    parseCSV, parseLots, parseAchats, validateLotRows, validateAchatRows, checkData, computeGaps,
    buildRegistry, summarize, modeText, draw, createRecord, checkRecord, buildIndex,
    exportResultCSV, importResultCSV, resultFileName, parseQuery, search, fmtRange
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.TombolaEngine = api;
})();
