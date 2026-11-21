# Fotolabor

Eine schlanke Foto-Bearbeitungs-App, die komplett im Browser läuft – ohne Installation, ohne Server, ohne Upload. Deine Bilder verlassen nie dein Gerät.

## Starten

Variante 1 – einfach `index.html` im Browser öffnen.

Variante 2 – mit lokalem Server (dann ist die App auch installierbar und offline nutzbar):

```bash
python3 -m http.server 8000
# danach http://localhost:8000 öffnen
```

## Funktionen

**Laden**
- Datei auswählen, per Drag & Drop ablegen oder mit <kbd>Strg</kbd>+<kbd>V</kbd> aus der Zwischenablage einfügen
- „Beispielbild verwenden“ zum direkten Ausprobieren

**Anpassen** (nicht-destruktiv, jederzeit änderbar)
- Licht: Belichtung, Helligkeit, Kontrast, Lichter, Tiefen
- Farbe: Farbtemperatur, Tönung, Sättigung, Dynamik, Farbton
- Effekte: Schärfen, Weichzeichnen, Vignette, Körnung, Verblassen, Schwarzweiß, Sepia
- Live-Histogramm (RGB)
- Klick auf den Wert bzw. Doppelklick auf den Namen setzt einen Regler zurück

**Filter**
- 12 Vorlagen (Lebendig, Warm, Kühl, Vintage, Drama, Schwarzweiß, Noir, Verblasst, Sonnig, Analog, Pop …) mit Live-Vorschau
- Regelbare Filterstärke

**Zuschneiden & Transformieren**
- Freier Zuschnitt oder feste Seitenverhältnisse (Original, 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3) mit Drittel-Raster
- 90° drehen, horizontal/vertikal spiegeln
- Größe ändern (mit gekoppeltem Seitenverhältnis, hochwertiges Herunterskalieren)

**Sonstiges**
- Rückgängig / Wiederholen (bis zu 40 Schritte)
- Vorher/Nachher-Vergleich (Knopf gedrückt halten oder Taste <kbd>V</kbd>)
- Export als JPEG, PNG oder WebP in voller Auflösung mit wählbarer Qualität
- Läuft auch auf Smartphone und Tablet

## Tastenkürzel

| Kürzel | Aktion |
| --- | --- |
| <kbd>Strg</kbd>+<kbd>O</kbd> | Foto öffnen |
| <kbd>Strg</kbd>+<kbd>S</kbd> | Exportieren |
| <kbd>Strg</kbd>+<kbd>Z</kbd> | Rückgängig |
| <kbd>Strg</kbd>+<kbd>Umschalt</kbd>+<kbd>Z</kbd> / <kbd>Strg</kbd>+<kbd>Y</kbd> | Wiederholen |
| <kbd>V</kbd> (halten) | Vorher anzeigen |
| <kbd>Enter</kbd> | Zuschnitt anwenden (im Tab „Zuschneiden“) |

Auf dem Mac jeweils <kbd>⌘</kbd> statt <kbd>Strg</kbd>.

## Technik

- Reines HTML, CSS und JavaScript – keine Abhängigkeiten, kein Build-Schritt
- Eigene Pixel-Pipeline auf `<canvas>`; Bearbeitung erfolgt auf einer verkleinerten Vorschau, der Export rechnet in voller Auflösung
- Effektradien sind relativ zur Bildgröße, damit Vorschau und Export identisch aussehen
- Sehr große Bilder werden beim Laden auf ca. 16 Megapixel begrenzt (Canvas-Limit mobiler Browser)

| Datei | Inhalt |
| --- | --- |
| `index.html` | Oberfläche |
| `styles.css` | Gestaltung (inkl. Mobil-Layout) |
| `app.js` | Bildverarbeitung, Verlauf, Zuschneiden, Export |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | Installierbare App / Offline-Nutzung |
