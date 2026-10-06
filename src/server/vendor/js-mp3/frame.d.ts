export interface Mp3Source {
  pos: number;
  skipTags(): { err?: unknown };
}
export interface Mp3Frame {
  /** 16-bit little-endian samples, channels interleaved. */
  decode(): Uint8Array;
}
declare const Frame: {
  read(source: Mp3Source, position: number, prev: Mp3Frame | null): { f: Mp3Frame; err?: unknown };
};
export default Frame;
