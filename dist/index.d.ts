import { JSONSchema4 } from 'json-schema';
import { Options as PrettierOptions } from 'prettier';
import { Options as AjvOptions } from 'ajv';
export interface Options {
    style?: PrettierOptions;
    ajvOptions?: AjvOptions;
    decoderName?: string;
    pack?: boolean;
}
export declare function generateFromFile(inputFile: string, outputFolder: string, options?: Options): Promise<void>;
export declare function generate(schema: JSONSchema4, outputFolder: string, options?: Options): Promise<void>;
