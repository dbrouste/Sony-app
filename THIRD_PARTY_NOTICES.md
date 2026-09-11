# Third-party notices

The local `expo-astrometry` module contains a native Android adaptation of
Astrometry.net source code and its bundled numerical dependencies.

The JNI/CMake integration was adapted from
[DIPE014/Astro-Mobile-App](https://github.com/DIPE014/Astro-Mobile-App), copyright
2026 Nguyen-Quang-Trung, under the MIT License. Its license text is preserved as
`modules/expo-astrometry/UPSTREAM_LICENSE`.

The native source tree contains code from Astrometry.net and bundled components,
including `gsl-an`, `libkd`, and `qfits-an`. Relevant license texts and source
copyright headers are preserved in the module. In particular:

- `modules/expo-astrometry/GSL_COPYING`
- `modules/expo-astrometry/LIBKD_LICENSE`

Because the linked native solver includes GPL-covered components, distributions
containing this module must comply with the applicable GNU GPL requirements.
The Astrometry.net index files are not included in the application package; they
are downloaded separately from `https://data.astrometry.net/4100/`.
