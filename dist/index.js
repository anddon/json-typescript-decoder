var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { compile as jsonSchemaToTypescript } from 'json-schema-to-typescript';
import { lstatSync, existsSync, writeFile, mkdirSync, readFileSync } from 'fs';
import { resolve, join, basename } from 'path';
import { camelCase, upperFirst, size } from 'lodash';
import Ajv from 'ajv';
import { format as prettify } from 'prettier';
import pack from 'ajv-pack';
const validatorFilePostfix = '.validate.js';
export function generateFromFile(inputFile, outputFolder, options) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!existsSync(inputFile)) {
            throw new Error(`Input schema file ${inputFile} not found`);
        }
        const schema = readFileSync(resolve(inputFile));
        return generate(schema, outputFolder, options);
    });
}
function writeFilePromise(file, data) {
    return new Promise(function (resolve, reject) {
        const buffer = new Buffer(data, 'utf8');
        if (existsSync(file)) {
            // Compare the contents of the file before writing
            // We only write the file when the contents has changed to prevent compile events
            // when running the typescript compiler in watch mode
            var existingFile = readFileSync(file);
            if (existingFile.equals(buffer)) {
                // The contents is the same, do not write the file and resolve the promise
                resolve(data);
                return;
            }
        }
        writeFile(file, data, function (err) {
            if (err)
                reject(err);
            else
                resolve(data);
        });
    });
}
export function generate(schema, outputFolder, options) {
    return __awaiter(this, void 0, void 0, function* () {
        schema = { definitions: schema.definitions };
        options = options || {};
        options.pack = options.pack === undefined ? true : options.pack;
        if (!existsSync(outputFolder)) {
            mkdirSync(outputFolder);
        }
        if (!lstatSync(outputFolder).isDirectory()) {
            throw new Error(`Output folder ${outputFolder} should be a directory`);
        }
        if (!schema.definitions || size(schema.definitions) === 0) {
            throw new Error(`No definitions found`);
        }
        const ajv = new Ajv(Object.assign(Object.assign({}, options.ajvOptions), { sourceCode: true, async: false }));
        ajv.addSchema(schema, 'schema');
        const writeFiles = [];
        let imports = [];
        let decoders = [];
        // Loop through all the definitions and generate the corresponding code
        for (const definitionKey of Object.keys(schema.definitions)) {
            const definition = schema.definitions[definitionKey];
            // Generate safe name (hopefullly matching that of json-schema-to-typescript)
            const name = toSafeString(definition.title || definitionKey);
            const validate = ajv.getSchema(`schema#/definitions/${definitionKey}`);
            // Write code of definition to single file
            if (options.pack && validate) {
                const validatorFileName = `${name}${validatorFilePostfix}`;
                imports.push(`import * as ${name}$validate from './${validatorFileName}'`);
                decoders.push(decoderPack(name));
                var moduleCode = pack(ajv, validate);
                writeFiles.push(writeFilePromise(join(outputFolder, validatorFileName), moduleCode));
            }
            else {
                decoders.push(decoderNoPack(name));
            }
        }
        yield Promise.all(writeFiles);
        // Generate the typescript models from the json schema
        const model = yield jsonSchemaToTypescript(schema, 'GeneratedContainerSchema', { unreachableDefinitions: true, style: options.style });
        // Remove the empty container interface from the generated code
        const cleanModel = model.replace(/export\s+interface\s+GeneratedContainerSchema\s+{[^\}]*\}/, '');
        const decoderName = options.decoderName || toSafeString(basename(outputFolder)) + 'Decoder';
        // Generate the code including the fromJson methods
        let code;
        if (options.pack === true) {
            code = templatePack(cleanModel, imports.join('\n'), decoders.join('\n'), decoderName);
        }
        else {
            code = templateNoPack(cleanModel, decoders.join('\n'), decoderName, schema, options.ajvOptions);
        }
        // Prettify the generated code
        const prettyCode = prettify(code, Object.assign({ parser: 'typescript' }, options.style));
        // Write the code to the output folder
        yield writeFilePromise(join(outputFolder, 'index.ts'), prettyCode);
    });
}
function toSafeString(string) {
    return upperFirst(camelCase(string));
}
function decoderPack(name) {
    return `static ${name} = decode<${name}>(${name}$validate, '${name}');`;
}
function decoderNoPack(name) {
    return `static ${name} = decode<${name}>('${name}');`;
}
function templateNoPack(models, decoders, decoderName, schema, ajvOptions) {
    return `
/* tslint:disable */
import * as Ajv from 'ajv';

${models}

let ajv: Ajv.Ajv;

function lazyAjv() {
  if (!ajv) {
    ajv = new Ajv(${JSON.stringify(ajvOptions || {})});
    ajv.addSchema(schema, 'schema');
  }

  return ajv;
}

const schema = ${JSON.stringify(schema)};
function decode<T>(dataPath: string): (json: any) => T {
  let validator: Ajv.ValidateFunction;
  return (json: any) => {
    if (!validator) {
      validator = lazyAjv().getSchema(\`schema#/definitions/\${dataPath}\`);
    }

    if (!validator(json)) {
      const errors = validator.errors || [];
      const errorMessage = errors.map(error => \`\${error.dataPath} \${error.message}\`.trim()).join(', ') || 'unknown';
      throw new ${decoderName}Error(\`Error validating \${dataPath}: \${errorMessage}\`, json);
    }

    return json as T;
  }
}
${decoder(decoders, decoderName)}`;
}
function templatePack(models, imports, decoders, decoderName) {
    return `
/* tslint:disable */
${imports}

${models}

function decode<T>(validator: (json: any) => boolean, dataPath: string): (json: any) => T {
  return (json: any) => {
    if (!validator(json)) {
      const errors: any[] = ((validator as any).errors as any) || [];
      const errorMessage = errors.map(error => \`\${error.dataPath} \${error.message}\`.trim()).join(', ') || 'unknown';
      throw new ${decoderName}Error(\`Error validating \${dataPath}: \${errorMessage}\`, json);
    }

    return json as T;
  }
}

${decoder(decoders, decoderName)}`;
}
function decoder(decoders, decoderName) {
    return `
export class ${decoderName}Error extends Error {
  readonly json: any;

  constructor(message: string, json: any) {
    super(message);
    this.json = json;
  }
}

export class ${decoderName} {
  ${decoders}
}
`;
}
//# sourceMappingURL=index.js.map