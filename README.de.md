![E-Mail-Konten](banner.svg)

# E-Mail-Konten

Deine Postfächer von Gmail, Outlook, web.de, GMX, T-Online, iCloud, Yahoo, Posteo, mailbox.org oder der eigenen Domain direkt in Hostwerk: alle Posteingänge zusammen, Ordner, Konversationen, Suche, sicheres Lesen mit Schutz vor Trackern und Phishing, Schreiben mit Signaturen, Vorlagen und Rückgängig-Senden, Regeln, Push über IMAP IDLE und Offline-Lesen. Die Einstellungen findet Hostwerk selbst – ohne eigene Anbieterliste.

[English](README.md) · Eine offizielle [Hostwerk](https://github.com/Passimoritz/hostwerk-public)-Erweiterung (SDK 3.3, native Erweiterung, Hostwerk 3.0+)

## Was sie kann

- **Wo:** *E-Mail → Postfächer* (neben Mail-Fänger und Mailserver), eine Kachel für die Übersicht und die ganze Seite unter *Erweiterungen → Öffnen*. Kein eigener Eintrag in der Seitenleiste.
- **Konto verbinden:** Adresse eintippen – Hostwerk sucht die Server selbst (siehe unten), zeigt, wo es sie gefunden hat, gibt Hinweise wie „IMAP erst in den Web-Einstellungen einschalten“ oder „App-Passwort verwenden“, prüft die Anmeldung und speichert erst dann. Für alles andere: selbst eintragen. Der **Mail-Fänger** (IMAP an) und Postfächer der Erweiterung **Mailserver** sind mit einem Klick verbunden.
- **Lesen:** alle Posteingänge zusammen oder je Konto, IMAP-Ordner mit ihrer Rolle (SPECIAL-USE: Posteingang, Gesendet, Entwürfe, Archiv, Spam, Papierkorb – auch deutsch benannte), Konversationen (Message-ID-Kette, sonst Betreff), Filter (ungelesen, markiert, Anhänge), Suche auf dem Server (IMAP SEARCH, bei Gmail mit Gmails eigener Suchsprache) plus lokaler Zwischenspeicher, „Mehr laden“.
- **Sichere Anzeige:** Die Mail läuft in einem abgeschotteten Rahmen ohne Skripte und mit eigener Sicherheitsrichtlinie; HTML wird bereinigt (keine Skripte, Formulare, Rahmen, Ereignis-Attribute, `javascript:`); Bilder aus dem Internet erst auf Klick („immer bei diesem Absender“ möglich); Zählpixel fliegen immer raus und werden gezählt; Links zeigen ihr Ziel und fragen nach, wenn der sichtbare Text auf eine andere Domain zeigt.
- **Phishing-Hinweise** ohne Listen: SPF/DKIM/DMARC aus dem obersten `Authentication-Results` (setzt dein eigener Anbieter), Anzeigename mit fremder Adresse/Domain, Antwort-an woandershin, Linktext ≠ Linkziel, nackte IP-Adressen, ähnlich aussehende Domains (Punycode), riskante Anhänge (`.exe`, `.js`, Makros …).
- **Anhänge:** Vorschau für Bilder, PDF, Text, Audio und Video; herunterladen; in einen Ordner speichern (einer oder alle); `.eml` einer Mail, `.mbox` eines ganzen Ordners.
- **Schreiben:** Antworten, allen antworten, weiterleiten (mit Anhängen), formatiert oder als reiner Text, Signatur und Aliasse je Konto, Empfänger-Vorschläge aus deinen Mails, Vorlagen, Wichtig/Lesebestätigung, Anhang-Erinnerung, Entwürfe auf dem Server (alle 30 s gespeichert), **Rückgängig-Senden** (Standard 10 s), Postausgang mit „Erneut versuchen“, wenn eine Mail nicht rausgeht. Gesendete Mails landen in „Gesendet“ (nicht bei Gmail, das macht das selbst).
- **Ordnen:** gelesen/ungelesen, markieren, archivieren (Ordner wird angelegt, falls er fehlt), Spam, verschieben (auch per Ziehen auf einen Ordner), löschen in den Papierkorb (aus dem Papierkorb endgültig, nach Rückfrage), Massenaktionen, Rechtsklick-Menüs überall.
- **Push statt Abfragen:** Je Konto beobachtet eine IMAP-IDLE-Verbindung den Posteingang; bricht sie ab, verbindet sie sich mit wachsender Pause neu (2 s … 5 min); nach falschem Passwort nur alle 30 min, damit der Anbieter das Konto nicht sperrt. Benachrichtigungen gebündelt (mehrere Mails in 20 s = eine), Ruhezeiten, je Konto abschaltbar; Ungelesen-Zähler in der Liste und auf der Kachel.
- **Regeln:** Absender/Empfänger/Betreff/Newsletter/Anhang → verschieben, gelesen, markieren, archivieren, Papierkorb, keine Benachrichtigung. Keine Weiterleitung per Regel (mit Absicht – beliebt bei Angreifern).
- **Abmelden** über `List-Unsubscribe` – mit einem Klick (RFC 8058), ohne eine Webseite zu öffnen, sonst Link oder vorbereitete Mail.
- **KI-Hilfe** (freiwillig, ab Werk aus): zusammenfassen, übersetzen, „Was wollen die?“ für jeweils eine Mail über Hostwerks KI-Helfer (`host.ai.quick`). Nur nach deiner Zustimmung; mit einem lokalen Modell verlässt nichts den PC.
- **Offline:** Zuletzt geöffnete und die neuesten Mails im Posteingang bleiben auf dem PC (Standard 300 MB, die am längsten nicht geöffneten fliegen zuerst raus); ohne Verbindung kommen Listen und Mails aus dem Zwischenspeicher; Hostwerks Offline-Modus wird beachtet (keine Verbindungen, Senden wartet).
- **Sicherung:** Konten (Geheimnisse verschlüsselt), Regeln, Vorlagen und Einstellungen stehen in Hostwerks Sicherungs-Zentrale (täglicher Stand, 10 behalten, Zurückspielen und externe Sicherung). Die Mails bleiben auf den Mail-Servern.
- **Tastatur:** J/K, Enter, R, A, F, E, #/Entf, S, U, X, C, /, Esc in der Liste; Strg+Enter sendet, Strg+S speichert den Entwurf; überall Strg+Alt+M (schreiben) und Strg+Alt+I (öffnen) – änderbar unter *Einstellungen → Allgemein → Tastenkürzel*.

## Einstellungen finden – ohne Liste, die jemand pflegen muss

Reihenfolge wie bei Thunderbird; die Quellen halten Anbieter und Mozilla aktuell:

| Schritt | Wo | Beispiel |
|---|---|---|
| 1 | Autoconfig des Anbieters: `https://autoconfig.<domain>/mail/config-v1.1.xml`, `https://<domain>/.well-known/autoconfig/…` | eigene Domains, viele Hoster |
| 2 | Mozillas ISPDB `https://autoconfig.thunderbird.net/v1.1/<domain>` (nur die Domain geht raus) | gmail.com, web.de, gmx.de, t-online.de, icloud.com, yahoo.com, posteo.de, mailbox.org, outlook.com |
| 3 | MX deiner Domain → Domain des Mail-Hosters → ISPDB dort | eigene Domain bei Google Workspace, Microsoft 365, IONOS … |
| 4 | DNS-SRV (RFC 6186/8314): `_imaps._tcp`, `_imap._tcp`, `_submissions._tcp`, `_submission._tcp` | selbst betrieben |
| 5 | Microsoft-Autodiscover (POX) mit Umleitung | Exchange |
| 6 | Raten mit Probe (`imap.`/`mail.`/`smtp.` + Port): nur die Begrüßung, nie Zugangsdaten | kleine Hoster |

OAuth-Endpunkte und -Rechte kommen ebenfalls aus der ISPDB (`<oAuth2>`) oder aus der OpenID-Beschreibung des Anbieters – nicht von Hostwerk.

## Anmeldung – ehrlich, je Anbieter

| Anbieter | Was geht | Hinweise |
|---|---|---|
| Gmail / Google Workspace | **App-Passwort** (braucht Bestätigung in zwei Schritten) | OAuth mit eigenem Google-Cloud-Client („Desktop-App“) geht auch – solange die App bei Google im Status „Test“ ist, beendet Google die Anmeldung aber nach 7 Tagen; eine veröffentlichte App mit Gmail-Recht braucht Googles Prüfung. Das App-Passwort ist der praktische Weg. |
| Outlook.com / Hotmail / Live | **nur OAuth** | Microsoft hat die Anmeldung mit Passwort für IMAP/SMTP abgeschaltet. Einmal kostenlos eine App in Microsoft Entra registrieren („persönliche Microsoft-Konten“, Plattform „Mobilgerät und Desktop“, Rücksprung `http://localhost/api/x/mail-accounts/pub/oauth`) und die Client-ID einfügen. |
| Microsoft 365 (Firma) | OAuth (eigene App, ggf. Zustimmung des Admins) | der Mandant kann SMTP AUTH abschalten – dann geht Senden nicht. |
| web.de, GMX | Passwort, mit 2FA App-Passwort | IMAP muss zuerst in den Web-Einstellungen eingeschaltet werden – Hostwerk zeigt den Link aus der ISPDB. |
| T-Online | das eigene *E-Mail-Passwort* | nicht das Login-Passwort des Kundencenters. |
| iCloud | **App-spezifisches Passwort** | anlegen unter appleid.apple.com. |
| Yahoo, AOL | **App-Passwort** | |
| Posteo, mailbox.org | Passwort (bei mailbox.org mit 2FA App-Passwort) | |
| Eigene Domain / Hoster | Passwort | Einstellungen über Autoconfig, SRV, MX oder Autodiscover. |
| Mail-Fänger, eigener Mailserver | ein Klick / Postfach-Passwort | lokal; ohne Verschlüsselung nur auf diesem PC oder im Heimnetz. |

Warum keine eingebaute OAuth-App? Google und Microsoft geben OAuth nur an registrierte Apps. Eine Registrierung für alle Hostwerk-Nutzer müsste ständig gepflegt werden (Prüfung, Sicherheitsbewertung, Fristen) und könnte jederzeit gesperrt werden – genau die Wartung, die diese Erweiterung vermeidet. Mit deiner eigenen App-ID hängst du von niemandem ab. Token werden von selbst erneuert (auch wechselnde Refresh-Token).

## Sicherheit

- Passwörter, Client-Geheimnisse und Refresh-Token liegen verschlüsselt mit Hostwerks Schlüssel (`host.core('secrets')` – in der Desktop-App im Schlüsselbund des Systems; Rückfall: eigener AES-256-GCM-Schlüssel im Datenordner, nur für den Besitzer lesbar). Nie im Klartext, nie an die Oberfläche.
- **Zertifikatsfehler werden nie still übergangen.** Kann ein Server sein Zertifikat nicht belegen (selbst signiert, Firmen-CA, falscher Name), zeigt Hostwerk Aussteller, Gültigkeit und SHA-256-Fingerabdruck; nur wenn du genau diesem Zertifikat vertraust, merkt sich das Konto es – für diesen einen Server. Ändert es sich, fragt Hostwerk erneut. Vorher gehen keine Zugangsdaten raus.
- Ohne Verschlüsselung nur zu Servern auf diesem PC oder im Heimnetz (Mail-Fänger, eigener Mailserver).
- Recht `connect:mail` (SDK 3.3): IMAP/SMTP/POP3 zu den Servern, die du einträgst, plus deren Einstellungen suchen. Abgeschottet (nicht aus dem offiziellen Katalog) nur die Mail-Ports und nie ins Heimnetz – das erzwingt Hostwerk.
- Spuren nur im eigenen Datenordner (`data/mail-accounts`) – nichts außerhalb.

## Rechte

| Recht | Wofür |
|---|---|
| `native` | eigener Server-Teil (IMAP/SMTP-Verbindungen, Push, Regeln) und Oberfläche |
| `connect:mail` | Mail-Server sind frei wählbar – eine feste Adressliste geht nicht |
| `use:ai` | freiwillige KI-Hilfe für eine Mail (nur nach deiner Zustimmung) |

## Entwickeln

```
npm i --no-save                      # imapflow, nodemailer, mailparser, sanitize-html, esbuild (feste Versionen)
node scripts/vendor.js               # → server/vendor/mail-libs.js + LICENSES.txt (Hostwerk kopiert keine node_modules)
node <hostwerk>/server/extensions/sdk/build-native.js .   # → ui/index.js
node <hostwerk>/server/extensions/sdk/check.js . --strict
node --test tests/*.test.js          # lokale IMAP/SMTP-Testserver, keine echten Konten, kein Netz
```

Tests: Einstellungen finden (ISPDB-XML, Autodiscover, MX, SRV, Raten), IMAP gegen einen lokalen Testserver (Anmelden, Ordner und Rollen, Liste, Lesen, Anhänge, Flags, Verschieben, Löschen, Suchen, IDLE-Push mit Regeln und gebündelter Meldung, Wiederverbindung nach Abbruch, Offline-Zwischenspeicher, Zertifikat-Vertrauen mit selbst signiertem Zertifikat), SMTP-Senden mit Rückgängig, Antwort-Kette, Entwürfe, „Gesendet“, Fehler im Postausgang, mbox-Export, Sicherung/Zurückspielen, HTML-Bereinigung, Phishing-Regeln, Abmelden, verschlüsselte Geheimnisse, Speichergrenzen, Regeln, Ruhezeiten, Kontakte, Konversationen, OAuth (PKCE, Rücksprung, Erneuern) gegen einen nachgebildeten Endpunkt.

Mitgelieferte Bibliotheken (MIT, MIT-0 und weitere – siehe `server/vendor/LICENSES.txt`): [imapflow](https://github.com/postalsys/imapflow), [nodemailer](https://nodemailer.com), [mailparser](https://github.com/nodemailer/mailparser), [sanitize-html](https://github.com/apostrophecms/sanitize-html).

## Grenzen

- Läuft, solange Hostwerk läuft: Regeln und Benachrichtigungen wirken nur dann (Verpasstes wird nach dem Neuverbinden nachgeholt).
- Keine POP3-Konten (nur IMAP), kein S/MIME/PGP, kein Kalender-/Kontakte-Abgleich (CardDAV/CalDAV), kein Verschieben zwischen Konten.
- Die Suche in „Alle Posteingänge“ umfasst die Posteingänge plus den lokalen Zwischenspeicher; in einem Ordner durchsucht der Server den ganzen Ordner.
- Exchange ohne IMAP (nur EWS/Graph) geht nicht.
