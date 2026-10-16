declare module 'bloomfilter' {
  export class BloomFilter {
    constructor(bits: number | Uint32Array, hashes: number);
    readonly buckets: Uint32Array;
    readonly m: number;
    add(value: string): void;
    test(value: string): boolean;
    countBits(): number;
  }
}
