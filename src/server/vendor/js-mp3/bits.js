var Bits = {
    createNew: function (vec) {
        var bits = {
            vec: vec, // ArrayBuffer
            u8: new Uint8Array(vec),
            bitPos: 0,
            bytePos: 0
        };

        /**
         * @return {number}
         */
        bits.Bit = function () {
            if (bits.vec.byteLength <= bits.bytePos) {
                // TODO: Should this return error?
                return 0;
            }
            var tmp = (bits.u8[bits.bytePos] >>> (7 - bits.bitPos)) >>> 0;
            tmp &= 0x01;
            bits.bytePos += ((bits.bitPos + 1) >>> 3) >>> 0;
            bits.bitPos = (bits.bitPos + 1) & 0x07;
            return tmp;
        };

        /**
         * @return {number}
         */
        bits.Bits = function (num) {
            if (num === 0) {
                return 0;
            }
            if (bits.vec.byteLength <= bits.bytePos) {
                // TODO: Should this return error?
                return 0;
            }
            // One byte view for the whole buffer, read with a bounds check (0
            // past the end), instead of a new DataView on every read.
            var u8 = bits.u8, p = bits.bytePos, len = u8.length;
            var tmp = (((u8[p] << 24) >>> 0) | ((p + 1 < len ? u8[p + 1] : 0) << 16) | ((p + 2 < len ? u8[p + 2] : 0) << 8) | (p + 3 < len ? u8[p + 3] : 0)) >>> 0;
            tmp = (tmp << bits.bitPos) >>> 0;
            tmp = (tmp >>> (32 - num)) >>> 0;
            bits.bytePos += ((bits.bitPos + num) >>> 3) >>> 0;
            bits.bitPos = (bits.bitPos + num) & 0x07;
            return tmp;
        };

        bits.Tail = function (offset) {
            var a = new Uint8Array(bits.vec);
            return a.slice(bits.vec.byteLength - offset).buffer;
            // return new Uint8Array(bits.vec, bits.vec.byteLength - offset).buffer;
        };

        bits.LenInBytes = function () {
            return bits.vec.byteLength;
        };

        /**
         * @return {number}
         */
        bits.BitPos = function () {
            return ((bits.bytePos << 3) >>> 0) + bits.bitPos;
        };

        bits.SetPos = function (pos) {
            bits.bytePos = (pos >>> 3) >>> 0;
            bits.bitPos = (pos & 0x7) >>> 0;
        };

        return bits;
    },
    append: function (bits, buf) {
        return Bits.createNew(bits.vec.concat(buf));
    },
};

var getValue = function (dv, index) {
    if (index >= dv.byteLength) {
        return 0;
    }
    return dv.getUint8(index);
};

export default Bits;
