"""Test d'interface : index.html ouvert en file://, Chromium headless.

Usage : python tests/ui/test_ui.py <dossier_de_sortie>
(le dossier reçoit les CSV téléchargés ; aucune donnée n'est écrite dans le dépôt)
"""
import re
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
INDEX = (Path(__file__).resolve().parents[2] / "index.html").as_uri()
OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
checks = []


def check(cond, label):
    checks.append((bool(cond), label))
    print(("OK   " if cond else "ÉCHEC ") + label)


def watch(page, errors, downloads):
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("download", lambda d: downloads.append(d))


def stored_id(page):
    return page.evaluate("() => { const r = localStorage.getItem('tombola-namip:tirage'); return r && JSON.parse(r).tirage_id; }")


def search(page, q):
    page.fill("#search", q)
    page.press("#search", "Enter")
    return page.locator("#search-results li").all_inner_texts(), page.inner_text("#search-summary")


with sync_playwright() as p:
    browser = p.chromium.launch()
    errors, downloads = [], []

    # 1. Démo, tirage par double clic, téléchargement unique.
    ctx = browser.new_context(accept_downloads=True)
    page = ctx.new_page()
    watch(page, errors, downloads)
    page.goto(INDEX)
    check(page.is_disabled("#btn-draw"), "Tirer au sort désactivé sans import")
    page.click("#btn-demo")
    check(page.is_visible("#demo-banner"), "Bandeau DÉMONSTRATION visible")
    check("Garantie active" in page.inner_text("#recap-prep"), "Récapitulatif : garantie active")
    page.click("#tabbtn-tirage")
    page.dblclick("#btn-draw")
    check(page.is_visible("#dlg"), "Fenêtre de confirmation ouverte")
    check("45 tickets (T)" in page.inner_text("#dlg-body"), "Confirmation récapitule T=45")
    with page.expect_download() as dl:
        page.dblclick("#dlg-ok")
    page.wait_for_timeout(1500)
    check(len(downloads) == 1, f"Un seul téléchargement après double clic (vu : {len(downloads)})")
    d = dl.value
    check(d.suggested_filename.startswith("DEMO_tombola_resultat_") and d.suggested_filename.endswith(".csv"),
          "Nom du fichier : " + d.suggested_filename)
    csv_path = OUT / d.suggested_filename
    d.save_as(csv_path)
    raw = csv_path.read_bytes()
    check(raw.startswith(b"\xef\xbb\xbf"), "CSV en UTF-8 avec BOM")
    text = raw.decode("utf-8-sig")
    lines = text.strip().split("\r\n")
    check(lines[0] == "tirage_id;date_tirage;mode;version_algo;demo;type;ticket;acheteur_id;nom;lot_id;lot_description;remis",
          "En-tête du CSV")
    check(len(lines) == 1 + 45, f"45 lignes ticket, aucun lot non attribué (lignes : {len(lines) - 1})")
    check(sum(1 for l in lines if ";GAGNANT;" in l) == 12, "12 lignes GAGNANT")
    check("DÉMONSTRATION — résultat non valable" in text, "Mention DÉMONSTRATION dans le CSV")
    tid = stored_id(page)
    check(tid and tid.startswith("DEMO-"), "Tirage enregistré dans localStorage : " + str(tid))
    check(page.is_visible("#tab-bar"), "Vue Vérification affichée après le tirage")
    check(page.inner_text("#tabbtn-bar") == "3. Vérification", "Libellé de l'onglet : 3. Vérification")
    check(page.inner_text("#tab-bar h2") == "Vérification d'un ticket", "Titre : Vérification d'un ticket")
    check("Bar" not in page.inner_text("body"), "Aucune mention visible de « Bar »")
    csv_date = lines[1].split(";")[1]
    check(re.fullmatch(r"\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}", csv_date) is not None, "Date du CSV en heure locale : " + csv_date)
    check(all(l.split(";")[1] == csv_date for l in lines[1:]), "Même date sur chaque ligne du CSV")
    check(csv_date in page.inner_text("#bar-info"), "Date affichée identique à celle du CSV")
    check(page.evaluate("document.activeElement.id") == "search", "Focus automatique sur la recherche")
    res1, summary1 = search(page, "3-8")
    check(len(res1) == 6 and res1[0].startswith("Ticket 3 ") and res1[-1].startswith("Ticket 8 "), "Recherche 3-8 : 6 lignes, bornes incluses")
    check(summary1.startswith("6 ticket(s) consulté(s)"), "Résumé : " + summary1)
    res_gap, _ = search(page, "12 – 13")
    check(all("Non enregistré" in r for r in res_gap) and len(res_gap) == 2, "Trou 12–13 : non enregistrés")

    # 2. Rechargement : même résultat, verrouillé.
    page.reload()
    check(stored_id(page) == tid, "Après rechargement : même tirage_id")
    check(tid in page.inner_text("#bar-info"), "Après rechargement : tirage affiché")
    res2, _ = search(page, "3-8")
    check(res2 == res1, "Après rechargement : même résultat pour 3-8")
    check(page.is_disabled("#btn-draw") and page.is_disabled("#btn-import-lots"), "Tirage et import verrouillés")
    check(len(downloads) == 1, "Aucun nouveau téléchargement au rechargement")

    # 3. Deux onglets préparés : le second ne peut pas retirer.
    ctx2 = browser.new_context(accept_downloads=True)
    a, b = ctx2.new_page(), ctx2.new_page()
    dl_a, dl_b = [], []
    watch(a, errors, dl_a)
    watch(b, errors, dl_b)
    for pg in (a, b):
        pg.goto(INDEX)
        pg.click("#btn-demo")
        pg.click("#tabbtn-tirage")
    b.click("#btn-draw")
    a.click("#btn-draw")
    a.click("#dlg-ok")
    a.wait_for_timeout(500)
    if b.is_visible("#dlg-ok") and b.is_enabled("#dlg-ok"):
        b.click("#dlg-ok")
    b.wait_for_timeout(800)
    check(len(dl_a) == 1 and len(dl_b) == 0, f"Deux onglets : un seul tirage (téléchargements {len(dl_a)} / {len(dl_b)})")
    check(stored_id(a) == stored_id(b), "Deux onglets : même tirage_id")
    check(b.is_disabled("#btn-draw"), "Deuxième onglet verrouillé")

    # 4. Réimport dans un contexte navigateur vierge.
    ctx3 = browser.new_context()
    c = ctx3.new_page()
    watch(c, errors, [])
    c.goto(INDEX)
    check(stored_id(c) is None, "Contexte vierge : aucun tirage")
    c.click("#tabbtn-bar")
    c.set_input_files("#file-result", str(csv_path))
    c.wait_for_timeout(500)
    check(stored_id(c) == tid, "Réimport : même tirage_id")
    check(csv_date in c.inner_text("#bar-info"), "Réimport : date affichée telle quelle (" + csv_date + ")")
    res3, _ = search(c, "3-8")
    check(res3 == res1, "Réimport : même résultat pour 3-8")
    check(c.is_visible("#demo-banner"), "Réimport d'une démo : bandeau visible")
    check(c.is_disabled("#btn-draw"), "Réimport : tirage verrouillé")
    all_rows = [search(c, f"{t}")[0][0] for t in (1, 20, 50)]
    check(all_rows == [search(page, f"{t}")[0][0] for t in (1, 20, 50)], "Réimport : tickets 1, 20, 50 identiques")

    # 5. Import invalide : refusé, import précédent conservé, texte échappé.
    ctx4 = browser.new_context()
    e = ctx4.new_page()
    watch(e, errors, [])
    e.goto(INDEX)
    good = OUT / "achats_ok.csv"
    good.write_text("acheteur_id;nom;ticket_debut;ticket_fin\nA1;Ann;1;5\n", encoding="utf-8")
    bad = OUT / "achats_ko.csv"
    bad.write_text("acheteur_id;nom;ticket_debut;ticket_fin\nA1;<img src=x onerror=alert(1)>;1;5\nA2;Bob;5;10\n", encoding="utf-8")
    e.set_input_files("#file-achats", str(good))
    e.wait_for_timeout(300)
    e.set_input_files("#file-achats", str(bad))
    e.wait_for_timeout(300)
    msg = e.inner_text("#msg-achats")
    check("Ticket 5 en double" in msg and "Ligne 3" in msg, "Chevauchement 1–5 / 5–10 refusé, ticket 5 nommé")
    check(e.locator("#msg-achats img").count() == 0, "Texte importé échappé (aucune balise injectée)")
    kept = e.evaluate("JSON.parse(localStorage.getItem('tombola-namip:preparation')).achats.achats.length")
    check(kept == 1, "Import précédent valide conservé")

    # 6. Tirage réel, puis effacement protégé par EFFACER.
    ctx5 = browser.new_context(accept_downloads=True)
    r = ctx5.new_page()
    dl_r = []
    watch(r, errors, dl_r)
    r.goto(INDEX)
    lots = OUT / "lots_ok.csv"
    lots.write_text("lot_id;description\n1;Lot A\n2;=Lot B\n3;Lot C\n", encoding="utf-8")
    r.set_input_files("#file-lots", str(lots))
    r.set_input_files("#file-achats", str(good))
    r.wait_for_timeout(300)
    r.click("#tabbtn-tirage")
    r.click("#btn-draw")
    r.click("#dlg-ok")
    r.wait_for_timeout(800)
    check(len(dl_r) == 1 and dl_r[0].suggested_filename.startswith("tombola_resultat_"), "Tirage réel : fichier sans préfixe DEMO_")
    check(not r.is_visible("#demo-banner") and r.is_hidden("#btn-clear-demo"), "Tirage réel : pas de bandeau ni d'« Effacer la démo »")
    check(r.is_hidden("#btn-del-lots") and r.is_hidden("#btn-del-achats"), "Après tirage : boutons de suppression des imports masqués")
    r.click("#btn-delete-result")
    check(r.is_disabled("#dlg-ok"), "Supprimer le résultat : bouton inactif tant qu'EFFACER n'est pas tapé")
    check("Vérifiez que le CSV du résultat a bien été téléchargé : ce tirage sera perdu sur cet ordinateur." in r.inner_text("#dlg-body"),
          "Supprimer le résultat : rappel du CSV affiché (vouvoiement)")
    r.fill("#dlg-input", "effacer")
    check(r.is_disabled("#dlg-ok"), "Supprimer le résultat : « effacer » en minuscules refusé")
    r.fill("#dlg-input", "EFFACER")
    r.click("#dlg-ok")
    r.wait_for_timeout(600)
    check(stored_id(r) is None and r.is_visible("#tab-prep"), "Supprimer le résultat (réel) : retour à la Préparation")
    check("3\nlots (L)" in r.inner_text("#recap-prep") and r.is_enabled("#btn-draw"), "Supprimer le résultat (réel) : imports conservés, tirage possible")

    # 8. Suppression des imports, puis Supprimer le résultat et nouveau tirage (démo), puis Tout effacer.
    ctx7 = browser.new_context(accept_downloads=True)
    s = ctx7.new_page()
    dl_s = []
    watch(s, errors, dl_s)
    s.goto(INDEX)
    check(s.is_hidden("#btn-del-lots") and s.is_hidden("#btn-del-achats"), "Sans import : boutons Supprimer masqués")
    s.click("#btn-demo")
    check(s.is_visible("#btn-del-lots") and s.is_visible("#btn-del-achats"), "Après import : boutons Supprimer visibles")
    s.click("#btn-del-lots")
    check(s.is_visible("#dlg") and stored_id(s) is None, "Supprimer les lots : confirmation intégrée à la page")
    s.click("#dlg-ok")
    s.wait_for_timeout(600)
    check("Récapitulatif disponible après import" in s.inner_text("#recap-prep"), "Supprimer les lots : récapitulatif mis à jour")
    check(s.is_disabled("#btn-draw"), "Supprimer les lots : tirage désactivé")
    check(s.is_hidden("#btn-del-lots") and s.is_visible("#btn-del-achats"), "Supprimer les lots : seul « Supprimer les achats » reste")
    check(s.evaluate("JSON.parse(localStorage.getItem('tombola-namip:preparation')).lots") is None, "Supprimer les lots : retiré du stockage")
    s.click("#btn-del-achats")
    s.click("#dlg-cancel")
    check(s.is_visible("#btn-del-achats"), "Supprimer les achats : Annuler ne supprime rien")
    s.click("#btn-demo")
    s.click("#tabbtn-tirage")
    s.click("#btn-draw")
    s.click("#dlg-ok")
    s.wait_for_timeout(600)
    first_id = stored_id(s)
    s.click("#btn-delete-result")
    s.fill("#dlg-input", "EFFACER")
    s.click("#dlg-ok")
    s.wait_for_timeout(600)
    check(stored_id(s) is None and s.is_visible("#tab-prep"), "Supprimer le résultat (démo) : retour à la Préparation")
    check("45\ntickets (T)" in s.inner_text("#recap-prep") and s.is_visible("#demo-banner"), "Supprimer le résultat (démo) : données conservées")
    s.click("#tabbtn-tirage")
    s.click("#btn-draw")
    s.click("#dlg-ok")
    s.wait_for_timeout(600)
    second_id = stored_id(s)
    check(len(dl_s) == 2 and second_id and second_id != first_id, "Nouveau tirage après suppression du résultat")
    s.click("#btn-wipe-all")
    s.fill("#dlg-input", "Effacer")
    check(s.is_disabled("#dlg-ok"), "Tout effacer : « Effacer » refusé (sensible à la casse)")
    s.fill("#dlg-input", "EFFACER")
    s.click("#dlg-ok")
    s.wait_for_timeout(600)
    check(stored_id(s) is None and s.evaluate("localStorage.getItem('tombola-namip:preparation')") is None,
          "Tout effacer : lots, achats et résultat supprimés")
    check(s.is_disabled("#btn-draw") and s.is_hidden("#demo-banner"), "Tout effacer : retour à l'état vierge")

    # 7. Écriture localStorage en échec : erreur visible, résultat gardé en mémoire et téléchargé.
    ctx6 = browser.new_context(accept_downloads=True)
    ctx6.add_init_script("Storage.prototype.setItem = function () { throw new Error('quota simulé'); };")
    f = ctx6.new_page()
    dl_f = []
    watch(f, [], dl_f)
    f.goto(INDEX)
    f.click("#btn-demo")
    check("quota simulé" in f.inner_text("#alerts"), "Échec d'écriture des imports signalé")
    f.click("#tabbtn-tirage")
    f.click("#btn-draw")
    f.click("#dlg-ok")
    f.wait_for_timeout(800)
    check("a ÉCHOUÉ" in f.inner_text("#bar-info"), "Échec d'enregistrement du tirage affiché en gros")
    check(len(dl_f) == 1 and f.is_visible("#btn-redownload"), "Résultat téléchargé et retéléchargeable malgré l'échec")
    check(f.is_disabled("#btn-draw"), "Pas de nouveau tirage après l'échec d'enregistrement")
    check(len(search(f, "1-50")[0]) == 50, "Résultat consultable en mémoire")

    for cx in (ctx, ctx2, ctx3, ctx4, ctx5, ctx6, ctx7):
        cx.close()
    browser.close()

check(not errors, "Aucune erreur JavaScript" + ("" if not errors else " : " + " | ".join(errors)))
failed = [l for ok, l in checks if not ok]
print(f"\n{len(checks) - len(failed)}/{len(checks)} vérifications réussies")
sys.exit(1 if failed else 0)
