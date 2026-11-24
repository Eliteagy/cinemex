# Caption fonts

Bundled so the preview and the export (libass, `fontsdir`) draw the same letters.

| Font | Licence |
|---|---|
| Anton, Archivo Black, Bangers, Bebas Neue, Lilita One, Poppins Black, Great Vibes | SIL Open Font License 1.1 (`OFL.txt`) |
| Inter Black | SIL Open Font License 1.1; static instance (wght 900, opsz 32) of the Inter variable font, renamed "Inter Black" so libass and the preview find it by name |
| Permanent Marker | Apache License 2.0 |
| Abril Fatface, Black Ops One, Bungee, DM Serif Display, Monoton, Pacifico, Poppins ExtraBold, Press Start 2P, Righteous, Russo One, Staatliches | SIL Open Font License 1.1 (each family's licence with its copyright line in `licences/`; Poppins ExtraBold: `OFL.txt`) |
| Luckiest Guy | Apache License 2.0 (`licences/luckiestguy-LICENSE.txt`) |

Source: github.com/google/fonts.

Not bundled: **Birds of Paradise** (Marta style) is a personal-use font. The app reads it from the
Windows font folders when it is installed (`electron/fonts.cjs`) and copies it only into the
temporary export folder; without it the Marta keyword uses Great Vibes.
