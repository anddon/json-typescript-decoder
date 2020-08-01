"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generate = exports.generateFromFile = void 0;
const json_schema_to_typescript_1 = require("json-schema-to-typescript");
const fs_1 = require("fs");
const path_1 = require("path");
const lodash_1 = require("lodash");
const ajv_1 = __importDefault(require("ajv"));
const prettier_1 = require("prettier");
const ajv_pack_1 = __importDefault(require("ajv-pack"));
const validatorFilePostfix = '.validate.js';
function generateFromFile(inputFile, outputFolder, options) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!fs_1.existsSync(inputFile)) {
            throw new Error(`Input schema file ${inputFile} not found`);
        }
        const schema = JSON.parse(fs_1.readFileSync(path_1.resolve(inputFile), 'utf-8').toString());
        return generate(schema, outputFolder, options);
    });
}
exports.generateFromFile = generateFromFile;
function writeFilePromise(file, data) {
    return new Promise(function (resolve, reject) {
        const buffer = new Buffer(data, 'utf8');
        if (fs_1.existsSync(file)) {
            // Compare the contents of the file before writing
            // We only write the file when the contents has changed to prevent compile events
            // when running the typescript compiler in watch mode
            var existingFile = fs_1.readFileSync(file);
            if (existingFile.equals(buffer)) {
                // The contents is the same, do not write the file and resolve the promise
                resolve(data);
                return;
            }
        }
        fs_1.writeFile(file, data, function (err) {
            if (err)
                reject(err);
            else
                resolve(data);
        });
    });
}
function generate(schema, outputFolder, options) {
    return __awaiter(this, void 0, void 0, function* () {
        schema = { definitions: schema.definitions };
        options = options || {};
        options.pack = options.pack === undefined ? true : options.pack;
        if (!fs_1.existsSync(outputFolder)) {
            fs_1.mkdirSync(outputFolder);
        }
        if (!fs_1.lstatSync(outputFolder).isDirectory()) {
            throw new Error(`Output folder ${outputFolder} should be a directory`);
        }
        if (!schema.definitions || lodash_1.size(schema.definitions) === 0) {
            throw new Error(`No definitions found`);
        }
        const ajv = new ajv_1.default(Object.assign(Object.assign({}, options.ajvOptions), { sourceCode: true, async: false }));
        ajv.addSchema(schema, 'schema');
        const writeFiles = [];
        let imports = [];
        let decoders = [];
        // Loop through all the definitions and generate the corresponding code
        for (const definitionKey of Object.keys(schema.definitions)) {
            const definition = schema.definitions[definitionKey];
            // Generate safe name (hopefullly matching that of json-schema-to-typescript)
            const name = definition.tsType || definition.$id || definitionKey;
            const validate = ajv.getSchema(`schema#/definitions/${definitionKey}`);
            // Write code of definition to single file
            if (options.pack && validate) {
                const validatorFileName = `${name}${validatorFilePostfix}`;
                imports.push(`import ${name}$validate from './${validatorFileName}'`);
                decoders.push(decoderPack(name));
                var moduleCode = `/* eslint-disable */\n` + ajv_pack_1.default(ajv, validate);
                writeFiles.push(writeFilePromise(path_1.join(outputFolder, validatorFileName), moduleCode));
            }
            else {
                decoders.push(decoderNoPack(name));
            }
        }
        yield Promise.all(writeFiles);
        // Generate the typescript models from the json schema
        const model = yield json_schema_to_typescript_1.compile(schema, 'GeneratedContainerSchema', {
            enableConstEnums: false,
            unreachableDefinitions: true,
            style: options.style
        });
        // Remove the empty container interface from the generated code
        const cleanModel = model.replace(/export\s+interface\s+GeneratedContainerSchema\s+{[^\}]*\}/, '');
        const decoderName = options.decoderName || toSafeString(path_1.basename(outputFolder)) + 'Decoder';
        // Generate the code including the fromJson methods
        let code;
        if (options.pack === true) {
            code = templatePack(cleanModel, imports.join('\n'), decoders.join('\n'), decoderName);
        }
        else {
            code = templateNoPack(cleanModel, decoders.join('\n'), decoderName, schema, options.ajvOptions);
        }
        // Prettify the generated code
        const prettyCode = prettier_1.format(code, Object.assign({ parser: 'typescript' }, options.style));
        // Write the code to the output folder
        yield writeFilePromise(path_1.join(outputFolder, 'index.ts'), prettyCode);
    });
}
exports.generate = generate;
function toSafeString(string) {
    return lodash_1.upperFirst(lodash_1.camelCase(string));
}
function decoderPack(name) {
    return `static ${name} = decode<${name}>(${name}$validate, '${name}');`;
}
function decoderNoPack(name) {
    return `static ${name} = decode<${name}>('${name}');`;
}
function templateNoPack(models, decoders, decoderName, schema, ajvOptions) {
    return `
/* eslint-disable */
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
/* eslint-disable */
${imports}

${models}

function decode<T>(validator: (json: any) => boolean, dataPath: string): (json: any) => T {
  return (json: any) => {
    if (!validator(json)) {
      const errors: any[] = ((validator as any).errors as any) || [];
      const errorMessage = errors.map(error => \`\${error.dataPath} \${error.message}\`.trim()).join(', ') || 'unknown';
      throw new ${decoderName}Error(\`Error validating \${dataPath}: \${errorMessage}\`, errors, json);
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

  constructor(message: string, errors?: any, json?: any) {
    super(message);
    this.errors = errors;
    this.json = json;
  }
}

export class ${decoderName} {
  ${decoders}
}
`;
}
//# sourceMappingURL=index.js.map