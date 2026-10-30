# Fonts

Served from the repository so builds do not depend on Google Fonts. Each file
covers Google Fonts' `latin` and `latin-ext` subsets (including æøå and the
Sámi letters ČŠŊŦŽĐ).

Source: the families in [google/fonts](https://github.com/google/fonts) (`ofl/ibmplexsans`,
`ofl/schibstedgrotesk`, `ofl/ibmplexmono`), licensed under the SIL Open Font
License 1.1 (`OFL-*.txt`). Built with fontTools:

```sh
fonttools varLib.instancer "IBMPlexSans[wdth,wght].ttf" wdth=100 wght=400:700 -o sans.ttf
fonttools varLib.instancer "SchibstedGrotesk[wght].ttf" wght=400:800 -o display.ttf
pyftsubset <font>.ttf --unicodes="<latin and latin-ext ranges>" \
  --layout-features='*' --no-hinting --desubroutinize --flavor=woff2
```

The IBM Plex Mono files are the static Regular, Medium and SemiBold fonts,
subset the same way. The Unicode ranges are those in Google Fonts' CSS for
the two subsets. IBM Plex reserves the name "Plex", so the subset Plex files
are renamed "Anbud Sans" and "Anbud Mono" in their name tables; copyright and
licence records are unchanged.
