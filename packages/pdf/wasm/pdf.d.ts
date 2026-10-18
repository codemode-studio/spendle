/* tslint:disable */
/* eslint-disable */

export interface PdfTextItem {
    text: string;
    /** 1-indexed page number. */
    page: number;
    /** PDF points from the page's lower-left corner, `y` growing upward. */
    x: number;
    y: number;
    width: number;
    height: number;
    itemType: "Text" | "Image" | "Link" | "FormField";
}

export interface PdfRead {
    text: string;
    items: PdfTextItem[];
    /** 0-indexed pages whose text is an image or unreliable. */
    pagesNeedingOcr: number[];
}



export function __wbg_reset_state(): void;

/**
 * Reads a PDF's plain text, its text fragments with their positions and the
 * pages that need OCR, in one pass over the bytes.
 */
export function readPdf(bytes: Uint8Array): PdfRead;

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly readPdf: (a: number, b: number, c: number) => void;
    readonly start: () => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export2: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
