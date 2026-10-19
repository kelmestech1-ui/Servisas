# Serviso programėlės diegimas

## A. „Apps Script“ pusė (serveris)
1. Apps Script projekte sukurkite naują failą **Api** (+ → Scenarijus) ir įklijuokite visą `Api.gs` turinį.
2. Faile `Api` pakeiskite **PIN kodus** (`API_PINS`) į savo (mechanikas / priėmėjas / vadovas). Rekomenduojama bent 6 skaitmenys.
3. Faile **Svetaine** pakeiskite visą turinį nauju `Svetaine.gs` (joje `doGet` pervadinta į `mechanicPage_`, nes `doGet` dabar yra faile `Api`).
4. Išsaugokite (Ctrl+S).
5. **Diegti → Tvarkyti diegimus → pieštukas → Nauja versija → Diegti.** URL lieka tas pats (baigiasi `/exec`). Prieiga: „Vykdyti kaip: Aš“, „Kas turi prieigą: Visi“.

## B. Programėlės talpinimas (GitHub Pages)
1. Susikurkite nemokamą paskyrą `github.com`, tada **New repository** (pvz., `servisas`, Public).
2. **Add file → Upload files** ir įkelkite visus failus iš aplanko `servisas-app` (`index.html`, `app.js`, `app.css`, `sw.js`, `config.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`). Paspauskite **Commit changes**.
3. **Settings → Pages → Branch: main, aplankas: / (root) → Save.** Po minutės nuoroda bus: `https://JŪSŲ-VARDAS.github.io/servisas/`
4. Repozitorijoje atidarykite `config.js` → pieštukas → į `API_URL` įrašykite savo „Apps Script“ `/exec` nuorodą → Commit.

Pastaba: nemokamas „GitHub Pages“ reikalauja viešo repozitorijaus, bet jame yra tik programėlės kodas. Duomenų ir PIN kodų jame nėra (PIN kodai yra tik „Apps Script“).

## C. Telefonuose
1. Atidarykite programėlės nuorodą **su internetu** ir prisijunkite PIN kodu (pirmą kartą interneto reikia).
2. **iPhone (Safari):** Dalintis → „Pridėti į pagrindinį ekraną“. **Android (Chrome):** meniu → „Įdiegti programėlę“.
3. Atidarykite iš pagrindinio ekrano ikonos.

## D. Patikrinimas be interneto
1. Telefone įjunkite lėktuvo režimą.
2. Atidarykite programėlę, sukurkite bandomąjį priėmimą arba komentarą. Viršuje matysite „Be interneto“ ir „Neišsiųsta: N“.
3. Išjunkite lėktuvo režimą. Per kelias sekundes įrašai nusiųsti, o lentelėje atsirado eilutė.

## Svarbu
- „iPhone“ sinchronizuoja tik kol programėlė atidaryta. Atidarius po ryšio atsiradimo, siuntimas vyksta automatiškai.
- Priėmimo Nr. suteikia lentelės formulė, todėl naujam priėmimui be interneto jis atsiranda tik išsiuntus.
- Skiltyje „Siuntimas“ matote neišsiųstus įrašus ir klaidas (galima bandyti dar kartą arba pašalinti).
- Kai keičiate programėlės failus GitHub, telefonai naują versiją gauna automatiškai, kai atidaromi su internetu.
