# js-mp3 (vendored)

A pure JavaScript MP3 decoder (MPEG-1 Layer III), from
[soundbus-technologies/js-mp3](https://github.com/soundbus-technologies/js-mp3)
0.1.0, itself a translation of [hajimehoshi/go-mp3](https://github.com/hajimehoshi/go-mp3).
MIT, see `LICENSE`.

Vendored rather than installed because the app measures sounds in its Worker
(`../../audio-measure.ts`), and the upstream package is unmaintained and slow
there. Changes from 0.1.0, all with byte-identical output (checked on stereo,
mono, CBR and VBR files):

- CommonJS to ES modules (`require` to `import`, `module.exports` to `export default`).
- `bits.js`: reads bytes from one `Uint8Array` instead of creating a `DataView` per bit.
- `frame.js` `subbandSynthesis`: shifts its vector in place and reuses its
  buffers instead of slicing new arrays, and computes the 64-row synthesis
  matrix from 32 cosine sums (each row is one of them, negated or zero).

Together about 1.9x faster than 0.1.0.
