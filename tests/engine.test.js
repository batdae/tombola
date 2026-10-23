'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');

// RNG déterministe pour les tests uniquement (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function makeLots(n) {
  return Array.from({ length: n }, (_, i) => ({ lot_id: i + 1, description: 'Lot ' + (i + 1) }));
}

// Répartit `tickets` tickets consécutifs (à partir de `start`) entre `buyers` acheteurs, au moins un chacun.
function makeAchats(buyers, tickets, start) {
  start = start || 1;
  const achats = [];
  let t = start;
  for (let b = 0; b < buyers; b++) {
    const size = Math.floor(tickets / buyers) + (b < tickets % buyers ? 1 : 0);
    achats.push({ acheteur_id: 'A' + b, nom: 'Nom ' + b, debut: t, fin: t + size - 1 });
    t += size;
  }
  return achats;
}

function rngs(count) {
  const list = [];
  for (let i = 0; i < count; i++) list.push({ label: 'seed ' + i, rng: seeded(1000 + i) });
  for (let i = 0; i < count; i++) list.push({ label: 'crypto ' + i, rng: E.cryptoRng() });
  return list;
}

// Vérifications indépendantes du moteur (sans réutiliser checkRecord).
function assertInvariants(lots, achats, res, label) {
  const reg = E.buildRegistry(achats);
  const K = Math.min(reg.tickets.length, lots.length);
  const P = reg.buyers.size;
  assert.equal(res.attributions.length, K, label + ' : K attributions');
  const tickets = res.attributions.map(p => p[0]);
  const lotIds = res.attributions.map(p => p[1]);
  assert.equal(new Set(tickets).size, K, label + ' : ticket en double');
  assert.equal(new Set(lotIds).size, K, label + ' : lot en double');
  const known = new Set(lots.map(l => l.lot_id));
  tickets.forEach(t => assert.ok(reg.owner.has(t), label + ' : ticket ' + t + ' hors registre'));
  lotIds.forEach(l => assert.ok(known.has(l), label + ' : lot ' + l + ' inconnu'));
  if (P <= lots.length) {
    assert.equal(res.mode, E.MODE_GARANTIE, label + ' : mode');
    const winners = new Set(tickets.map(t => reg.owner.get(t)));
    reg.buyers.forEach(b => assert.ok(winners.has(b.acheteur_id), label + ' : acheteur ' + b.acheteur_id + ' oublié'));
  } else {
    assert.equal(res.mode, E.MODE_CLASSIQUE, label + ' : mode');
  }
}

function errorText(res) { return res.errors.map(e => e.message).join('\n'); }

test('109 lots, 109 acheteurs : garantie active, chacun gagne', () => {
  const lots = makeLots(109);
  const achats = makeAchats(109, 500);
  for (const { label, rng } of rngs(5)) {
    const res = E.draw(lots, achats, rng);
    assert.equal(res.mode, E.MODE_GARANTIE);
    assertInvariants(lots, achats, res, label);
    const reg = E.buildRegistry(achats);
    const perBuyer = new Map();
    res.attributions.forEach(p => { const b = reg.owner.get(p[0]); perBuyer.set(b, (perBuyer.get(b) || 0) + 1); });
    assert.equal(perBuyer.size, 109);
    perBuyer.forEach(n => assert.equal(n, 1));
  }
});

test('109 lots, 110 acheteurs : garantie désactivée, 109 tickets gagnants distincts', () => {
  const lots = makeLots(109);
  const achats = makeAchats(110, 550);
  for (const { label, rng } of rngs(5)) {
    const res = E.draw(lots, achats, rng);
    assert.equal(res.mode, E.MODE_CLASSIQUE);
    assert.equal(new Set(res.attributions.map(p => p[0])).size, 109);
    assertInvariants(lots, achats, res, label);
  }
  assert.equal(E.summarize(lots, achats).mode, E.MODE_CLASSIQUE);
  assert.match(E.modeText(E.MODE_CLASSIQUE, 110, 109), /plus d'acheteurs \(110\) que de lots \(109\)/);
});

test('109 lots, 30 acheteurs, 400 tickets : 109 gains, chacun au moins un', () => {
  const lots = makeLots(109);
  const achats = makeAchats(30, 400);
  for (const { label, rng } of rngs(5)) {
    const res = E.draw(lots, achats, rng);
    assert.equal(res.mode, E.MODE_GARANTIE);
    assert.equal(res.attributions.length, 109);
    assertInvariants(lots, achats, res, label);
  }
});

test('109 lots, 31 tickets : 31 gagnants, 78 lots non attribués', () => {
  const lots = makeLots(109);
  const achats = makeAchats(10, 31);
  const rec = E.createRecord({ lots, achats, rng: seeded(7) });
  assert.equal(rec.attributions.length, 31);
  const idx = E.buildIndex(rec);
  assert.equal(idx.unassigned.length, 78);
  assert.equal(E.summarize(lots, achats).nonAttribues, 78);
  assert.deepEqual(E.checkRecord(rec), []);
});

test('T = L : chaque ticket gagne exactement une fois', () => {
  const lots = makeLots(50);
  const achats = makeAchats(12, 50);
  for (const { label, rng } of rngs(3)) {
    const res = E.draw(lots, achats, rng);
    assert.deepEqual(res.attributions.map(p => p[0]).sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i + 1), label);
  }
});

test('Un seul acheteur avec un seul ticket : un seul gain', () => {
  const res = E.draw(makeLots(109), [{ acheteur_id: 'A1', nom: 'Solo', debut: 42, fin: 42 }], seeded(1));
  assert.equal(res.attributions.length, 1);
  assert.equal(res.attributions[0][0], 42);
});

test('Un acheteur avec plusieurs plages compte pour une seule personne', () => {
  const r = E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA002;Michel;11;20\nA002;Michel;40;42\nA001;John;1;10\n');
  assert.ok(r.ok, errorText(r));
  const s = E.summarize(makeLots(5), r.achats);
  assert.equal(s.P, 2);
  assert.equal(s.T, 23);
});

test('Deux acheteurs au même nom avec des id différents : deux personnes', () => {
  const r = E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;Marie;1;3\nA2;Marie;4;6\n');
  assert.ok(r.ok, errorText(r));
  assert.equal(E.summarize(makeLots(5), r.achats).P, 2);
  const res = E.draw(makeLots(5), r.achats, seeded(3));
  const reg = E.buildRegistry(r.achats);
  assert.equal(new Set(res.attributions.map(p => reg.owner.get(p[0]))).size, 2);
});

test('Plages 1–5 et 5–10 : import bloqué, ticket 5 signalé', () => {
  const r = E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;Ann;1;5\nA2;Bob;5;10\n');
  assert.equal(r.ok, false);
  assert.match(errorText(r), /Ticket 5 en double/);
  assert.equal(r.errors[0].line, 3);
  const r2 = E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;Ann;1;8\nA2;Bob;5;10\n');
  assert.match(errorText(r2), /Tickets 5 à 8 en double : déjà présent ligne 2/);
});

test('Ticket 0 importé : valide et tirable', () => {
  const r = E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;Zéro;0;0\n');
  assert.ok(r.ok, errorText(r));
  assert.equal(r.achats[0].debut, 0);
  const res = E.draw(makeLots(3), r.achats, seeded(9));
  assert.deepEqual(res.attributions.map(p => p[0]), [0]);
  const idx = E.buildIndex(E.createRecord({ lots: makeLots(3), achats: r.achats, rng: seeded(9) }));
  assert.equal(E.search(idx, '0').lignes[0].statut, 'GAGNANT');
});

test('Trou entre deux ventes : jamais tiré, signalé comme trou', () => {
  const r = E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;Ann;1;10\nA2;Bob;21;30\nA3;Cid;33;33\n');
  assert.ok(r.ok, errorText(r));
  assert.deepEqual(r.gaps, [[11, 20], [31, 32]]);
  assert.match(r.infos.join(' '), /11–20, 31–32/);
  const lots = makeLots(21);
  for (const { rng } of rngs(20)) {
    const res = E.draw(lots, r.achats, rng);
    res.attributions.forEach(p => assert.ok(!(p[0] >= 11 && p[0] <= 20) && p[0] !== 31 && p[0] !== 32));
    assert.equal(res.attributions.length, 21);
  }
});

test('Même acheteur_id avec deux noms : bloqué', () => {
  const r = E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;Michel;1;2\nA1;Michelle;5;6\n');
  assert.equal(r.ok, false);
  assert.match(errorText(r), /deux noms différents/);
});

test('Validation : en-têtes, champs vides, entiers, bornes, lots en double', () => {
  assert.match(errorText(E.parseAchats('acheteur;nom;ticket_debut;ticket_fin\nA;B;1;2\n')), /En-tête manquant : « acheteur_id »/);
  assert.match(errorText(E.parseAchats('acheteur_id,nom,ticket_debut,ticket_fin\nA,B,1,2\n')), /séparateur point-virgule/);
  assert.match(errorText(E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;;1;2\n')), /« nom » vide/);
  assert.match(errorText(E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;X;-3;2\n')), /négatif/);
  assert.match(errorText(E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;X;1.5;2\n')), /pas un nombre entier/);
  assert.match(errorText(E.parseAchats('acheteur_id;nom;ticket_debut;ticket_fin\nA1;X;9;2\n')), /supérieur à ticket_fin/);
  const lots = E.parseLots('lot_id;description\n1;A\n2;B\n1;C\n');
  assert.equal(lots.ok, false);
  assert.match(errorText(lots), /lot_id 1 en double \(déjà présent ligne 2\)/);
  assert.equal(lots.errors[0].line, 4);
  assert.match(errorText(E.parseLots('lot_id;description\n0;A\n')), /supérieur ou égal à 1/);
  assert.match(errorText(E.parseLots('lot_id;description\n3;\n')), /« description » vide/);
});

test('CSV : BOM, guillemets, "" échappés, CRLF, lignes vides finales', () => {
  const text = '﻿lot_id;description\r\n7;"Coffret ""Radio ; TSF"""\r\n2;Session quiz (valeur 110€) - I-Quiz Charleroi\r\n\r\n\r\n';
  const r = E.parseLots(text);
  assert.ok(r.ok, errorText(r));
  assert.deepEqual(r.lots, [
    { lot_id: 7, description: 'Coffret "Radio ; TSF"' },
    { lot_id: 2, description: 'Session quiz (valeur 110€) - I-Quiz Charleroi' }
  ]);
  assert.equal(r.infos[0], '2 ligne(s) de lots lue(s).');
  assert.match(errorText(E.parseLots('lot_id;description\n1;"ouvert\n')), /jamais refermé/);
});

test('Tirage bloqué sans lot ou sans ticket', () => {
  assert.throws(() => E.draw([], makeAchats(2, 4), seeded(1)), /Aucun lot/);
  assert.throws(() => E.draw(makeLots(3), [], seeded(1)), /Aucun ticket/);
});

test('Recherche « 5-10 », « 5 – 10 », « 5—10 », « 7 » : bornes incluses', () => {
  const rec = E.createRecord({ lots: makeLots(3), achats: [{ acheteur_id: 'A', nom: 'N', debut: 1, fin: 8 }], rng: seeded(2) });
  const idx = E.buildIndex(rec);
  for (const q of ['5-10', '5 - 10', '5 – 10', '5—10', ' 10-5 ']) {
    const r = E.search(idx, q);
    assert.ok(r.ok, q);
    assert.deepEqual(r.lignes.map(l => l.ticket), [5, 6, 7, 8, 9, 10], q);
    assert.equal(r.consultes, 6);
    assert.equal(r.lignes[5].texte, 'Ticket 10 — Non enregistré (absent de la liste des tickets vendus)');
  }
  const one = E.search(idx, '7');
  assert.equal(one.lignes.length, 1);
  const total = rec.attributions.filter(p => p[0] >= 1 && p[0] <= 8).length;
  assert.equal(E.search(idx, '1-8').gagnants, total);
  const w = rec.attributions[0];
  assert.equal(E.search(idx, String(w[0])).lignes[0].texte, 'Ticket ' + w[0] + ' — GAGNANT — Lot n°' + w[1] + ' — Lot ' + w[1]);
  const big = E.search(idx, '1-2000');
  assert.equal(big.lignes.length, 500);
  assert.ok(big.tronque);
  assert.equal(E.search(idx, 'abc').ok, false);
  assert.equal(E.search(idx, '895001').lignes[0].statut, 'NON_ENREGISTRE');
});

test('Export puis réimport : attributions identiques, apostrophe anti-formule retirée', () => {
  const lots = [
    { lot_id: 1, description: '=SOMME(A1:A2)' },
    { lot_id: 2, description: '+33 dîner ; "chic"' },
    { lot_id: 3, description: '-Réduction' },
    { lot_id: 4, description: '@cadeau' },
    { lot_id: 5, description: '\'déjà apostrophe' },
    { lot_id: 6, description: 'Normal, accentué é' },
    { lot_id: 7, description: 'Jamais gagné' }
  ];
  const achats = [
    { acheteur_id: '=A1', nom: '-Michel', debut: 0, fin: 2 },
    { acheteur_id: 'B2', nom: 'Zoé', debut: 5, fin: 5 },
    { acheteur_id: '=A1', nom: '-Michel', debut: 9, fin: 9 }
  ];
  const rec = E.createRecord({ lots, achats, rng: seeded(11), now: new Date('2026-11-14T20:15:03Z') });
  const csv = E.exportResultCSV(rec);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.ok(csv.startsWith('﻿' + E.RESULT_HEADER.join(';') + '\r\n'));
  assert.match(csv, /;'=A1;'-Michel;/);
  assert.match(csv, /'=SOMME\(A1:A2\)/);
  assert.match(csv, /"'\+33 dîner ; ""chic"""/);
  assert.match(csv, /;''déjà apostrophe;/);
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 1 + 5 + 2);
  const back = E.importResultCSV(csv);
  assert.ok(back.ok, errorText(back));
  assert.deepEqual(back.record.attributions, rec.attributions);
  assert.deepEqual(back.record.lots, lots.slice().sort((a, b) => a.lot_id - b.lot_id));
  assert.deepEqual(back.record.achats, [
    { acheteur_id: '=A1', nom: '-Michel', debut: 0, fin: 2 },
    { acheteur_id: 'B2', nom: 'Zoé', debut: 5, fin: 5 },
    { acheteur_id: '=A1', nom: '-Michel', debut: 9, fin: 9 }
  ]);
  ['tirage_id', 'mode', 'version_algo', 'demo'].forEach(k => assert.equal(back.record[k], rec[k], k));
  assert.equal(back.record.date_tirage, E.displayDate(rec));
  assert.equal(E.exportResultCSV(back.record), csv);
  assert.match(E.resultFileName(rec), /^tombola_resultat_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);
});

test('Date exportée en heure locale lisible, conservée telle quelle au réimport', () => {
  const now = new Date('2026-10-23T09:40:24.693Z');
  const rec = E.createRecord({ lots: makeLots(3), achats: makeAchats(2, 5), rng: seeded(8), now });
  assert.equal(rec.date_tirage, '2026-10-23T09:40:24.693Z', 'ISO conservée en interne');
  const p2 = n => String(n).padStart(2, '0');
  const expected = p2(now.getDate()) + '/' + p2(now.getMonth() + 1) + '/' + now.getFullYear() + ' ' +
    p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds());
  assert.equal(E.displayDate(rec), expected);
  const csv = E.exportResultCSV(rec);
  const dates = csv.slice(1).trim().split('\r\n').slice(1).map(l => l.split(';')[1]);
  dates.forEach(d => assert.equal(d, expected));
  assert.ok(!csv.includes('T09:40:24'), 'pas de date ISO dans le CSV');
  const fileStamp = expected.replace(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/, '$3-$2-$1_$4-$5-$6');
  assert.equal(E.resultFileName(rec), 'tombola_resultat_' + fileStamp + '.csv');

  // Nouveau format : texte gardé tel quel, même si on le fabrique dans un autre fuseau.
  const shifted = csv.split(expected).join('01/02/2026 23:59:58');
  const back = E.importResultCSV(shifted);
  assert.ok(back.ok, errorText(back));
  assert.equal(back.record.date_tirage, '01/02/2026 23:59:58');
  assert.equal(E.displayDate(back.record), '01/02/2026 23:59:58');
  assert.equal(E.resultFileName(back.record), 'tombola_resultat_2026-02-01_23-59-58.csv');
  assert.equal(E.exportResultCSV(back.record), shifted);

  // Ancien format ISO : accepté et conservé tel quel.
  const old = csv.split(expected).join('2026-10-23T09:40:24.693Z');
  const backOld = E.importResultCSV(old);
  assert.ok(backOld.ok, errorText(backOld));
  assert.equal(backOld.record.date_tirage, '2026-10-23T09:40:24.693Z');
  assert.equal(E.displayDate(backOld.record), '2026-10-23T09:40:24.693Z');
  assert.equal(E.exportResultCSV(backOld.record), old);
  assert.match(E.resultFileName(backOld.record), /^tombola_resultat_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.csv$/);

  // Date illisible : refusée.
  assert.match(errorText(E.importResultCSV(csv.split(expected).join('hier soir'))), /date_tirage « hier soir » invalide/);
});

test('Export démo : marqué DÉMONSTRATION dans le CSV et le nom de fichier', () => {
  const l = E.parseLots(E.DEMO_LOTS_CSV);
  const a = E.parseAchats(E.DEMO_ACHATS_CSV);
  assert.ok(l.ok && a.ok);
  const rec = E.createRecord({ lots: l.lots, achats: a.achats, demo: true, rng: seeded(5) });
  assert.match(E.resultFileName(rec), /^DEMO_tombola_resultat_/);
  assert.ok(E.exportResultCSV(rec).includes(E.DEMO_VALUE));
  assert.equal(E.importResultCSV(E.exportResultCSV(rec)).record.demo, true);
});

test('Réimport : fichiers incohérents refusés', () => {
  const rec = E.createRecord({ lots: makeLots(4), achats: makeAchats(2, 6), rng: seeded(4) });
  const csv = E.exportResultCSV(rec);
  const lines = csv.split('\r\n');
  const twoIds = lines.map((l, i) => (i === 2 ? l.replace(rec.tirage_id, 'autre') : l)).join('\r\n');
  assert.match(errorText(E.importResultCSV(twoIds)), /un seul tirage/);
  const dupTicket = csv + lines[1] + '\r\n';
  assert.match(errorText(E.importResultCSV(dupTicket)), /en double/);
  const badType = lines.map((l, i) => (i === 1 ? l.replace(/;(GAGNANT|NON_GAGNANT);/, ';AUTRE;') : l)).join('\r\n');
  assert.match(errorText(E.importResultCSV(badType)), /Type « AUTRE » inconnu/);
  const loser = lines.findIndex(l => l.includes(';NON_GAGNANT;'));
  const extraWin = lines.map((l, i) => (i === loser ? l.replace(';NON_GAGNANT;', ';GAGNANT;').replace(/;;;$/, ';1;Lot 1;') : l)).join('\r\n');
  assert.equal(E.importResultCSV(extraWin).ok, false);
});

test('Invariants sur 1000 tirages de tailles variées (RNG déterministe et crypto)', () => {
  const pick = seeded(2026);
  for (let i = 0; i < 1000; i++) {
    const L = 1 + (pick() % 130);
    const P = 1 + (pick() % 150);
    const T = P + (pick() % 400);
    const achats = makeAchats(P, T, pick() % 3);
    // Quelques trous et plages non contiguës pour un même acheteur.
    if (i % 3 === 0 && achats.length > 2) {
      achats.forEach(a => { a.debut += 1000; a.fin += 1000; });
      achats.push({ acheteur_id: achats[0].acheteur_id, nom: achats[0].nom, debut: 5, fin: 5 + (pick() % 4) });
    }
    const lots = makeLots(L);
    const rng = i % 2 === 0 ? seeded(i) : E.cryptoRng();
    const rec = E.createRecord({ lots, achats, rng });
    assertInvariants(lots, achats, rec, 'tirage ' + i);
    assert.deepEqual(E.checkRecord(rec), [], 'tirage ' + i);
  }
});

test('Hasard : entier borné uniforme sans biais modulo', () => {
  // Source qui renvoie d'abord une valeur à rejeter pour n = 3 (au-delà de la plus grande multiple de 3).
  const values = [0xFFFFFFFF, 4];
  const rng = () => values.shift();
  assert.equal(E.randomInt(3, rng), 1);
  const counts = [0, 0, 0, 0, 0, 0];
  const c = E.cryptoRng();
  for (let i = 0; i < 60000; i++) counts[E.randomInt(6, c)]++;
  counts.forEach(n => assert.ok(n > 9000 && n < 11000, 'répartition ' + counts));
});

test('Sans crypto : tirage bloqué, aucune solution de repli', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(E.cryptoAvailable(), false);
    assert.throws(() => E.draw(makeLots(2), makeAchats(1, 2)), /crypto\.getRandomValues/);
  } finally {
    Object.defineProperty(globalThis, 'crypto', desc);
  }
  assert.equal(E.cryptoAvailable(), true);
});

test('Grep : aucune occurrence de Math.random dans engine.js et app.js', () => {
  for (const f of ['engine.js', 'app.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.equal(src.includes('Math.random'), false, f);
  }
});

test('Modèles CSV : identiques aux données de démonstration intégrées', () => {
  const norm = s => s.replace(/^﻿/, '').replace(/\r/g, '');
  assert.equal(norm(fs.readFileSync(path.join(ROOT, 'modeles', 'lots_modele.csv'), 'utf8')), E.DEMO_LOTS_CSV);
  assert.equal(norm(fs.readFileSync(path.join(ROOT, 'modeles', 'achats_modele.csv'), 'utf8')), E.DEMO_ACHATS_CSV);
});
