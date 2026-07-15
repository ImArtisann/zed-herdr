/**
 * The maximum UTF-8 byte length retained for a frame that has not reached a newline.
 * Complete frames are returned immediately and are intentionally not size-limited here.
 */
export const MAX_NDJSON_PARTIAL_FRAME_BYTES = 64 * 1024;

/** A peer sent an unterminated frame that exceeds the bounded decoder buffer. */
export class NdjsonFramingError extends Error {
    readonly _tag = "NdjsonFramingError";

    constructor(
        readonly limitBytes: number,
        readonly bufferedBytes: number,
    ) {
        super(`NDJSON partial frame exceeds ${limitBytes} bytes`);
        this.name = "NdjsonFramingError";
    }
}

/**
 * Incrementally separates UTF-8 NDJSON frames. It deliberately does not parse JSON
 * or validate protocol payloads; callers own that policy after receiving each frame.
 */
export class NdjsonDecoder {
    readonly #decoder = new TextDecoder();
    readonly #encoder = new TextEncoder();
    readonly #maximumPartialFrameBytes: number;
    #partial = "";

    constructor(maximumPartialFrameBytes = MAX_NDJSON_PARTIAL_FRAME_BYTES) {
        if (
            !Number.isSafeInteger(maximumPartialFrameBytes) ||
            maximumPartialFrameBytes < 64 * 1024
        ) {
            throw new RangeError(
                "maximumPartialFrameBytes must be a safe integer of at least 65536",
            );
        }

        this.#maximumPartialFrameBytes = maximumPartialFrameBytes;
    }

    /** Add a network chunk and return every completed line in arrival order. */
    push(chunk: Uint8Array): ReadonlyArray<string> {
        return this.#append(this.#decoder.decode(chunk, { stream: true }));
    }

    /** Flush decoder state and return the final trailing frame, if present. */
    end(): ReadonlyArray<string> {
        const frames = [...this.#append(this.#decoder.decode())];

        if (this.#partial.length > 0) {
            frames.push(this.#partial);
            this.#partial = "";
        }

        return frames;
    }

    #append(text: string): ReadonlyArray<string> {
        this.#partial += text;
        const frames: Array<string> = [];
        let newlineIndex = this.#partial.indexOf("\n");

        while (newlineIndex >= 0) {
            const frame = this.#partial.slice(0, newlineIndex);
            frames.push(frame.endsWith("\r") ? frame.slice(0, -1) : frame);
            this.#partial = this.#partial.slice(newlineIndex + 1);
            newlineIndex = this.#partial.indexOf("\n");
        }

        const bufferedBytes = this.#encoder.encode(this.#partial).byteLength;
        if (bufferedBytes > this.#maximumPartialFrameBytes) {
            throw new NdjsonFramingError(this.#maximumPartialFrameBytes, bufferedBytes);
        }

        return frames;
    }
}
