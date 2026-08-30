const schemaPath = "qcore/schema.json";

const outputPaths = {
  rust: "compiler/src/qcore_generated.rs",
  typescript: "src/qcore_generated.ts",
  lean: "formal/lean/Blot/QCoreGenerated.lean",
};

const primitiveTypes = new Set(["bool", "u8", "u32", "string"]);
const declarationNamePattern = /^[A-Z][A-Za-z0-9]*$/;
const fieldNamePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

type ReferenceRepresentation = "u32" | "string";

export interface ReferenceDefinition {
  readonly name: string;
  readonly representation: ReferenceRepresentation;
}

export interface FieldDefinition {
  readonly name: string;
  readonly type: string;
}

export interface RecordDefinition {
  readonly name: string;
  readonly fields: readonly FieldDefinition[];
}

export interface VariantDefinition {
  readonly name: string;
  readonly tag: number;
  readonly fields: readonly FieldDefinition[];
}

export interface UnionDefinition {
  readonly name: string;
  readonly tagType: "u8";
  readonly variants: readonly VariantDefinition[];
}

export interface QCoreSchema {
  readonly format: "blot-qcore-schema";
  readonly version: number;
  readonly references: readonly ReferenceDefinition[];
  readonly records: readonly RecordDefinition[];
  readonly unions: readonly UnionDefinition[];
}

export interface QCoreOutputs {
  readonly rust: string;
  readonly typescript: string;
  readonly lean: string;
}

export function decodeQCoreSchema(source: unknown): QCoreSchema {
  expectKeys(
    source,
    ["format", "version", "references", "records", "unions"],
    "QCore schema",
  );

  const format = stringField(source, "format", "QCore schema");
  if (format !== "blot-qcore-schema") {
    throw new Error(
      `QCore schema format must be blot-qcore-schema, received ${format}`,
    );
  }

  const version = integerField(source, "version", "QCore schema");
  if (version < 1) {
    throw new Error(
      `QCore schema version must be positive, received ${version}`,
    );
  }

  const references = arrayField(source, "references", "QCore schema").map(
    (entry, index) => decodeReference(entry, index),
  );
  const records = arrayField(source, "records", "QCore schema").map(
    (entry, index) => decodeRecord(entry, index),
  );
  const unions = arrayField(source, "unions", "QCore schema").map(
    (entry, index) => decodeUnion(entry, index),
  );

  const schema: QCoreSchema = {
    format,
    version,
    references,
    records,
    unions,
  };
  validateDeclarations(schema);
  return schema;
}

export function generateQCore(schema: QCoreSchema): QCoreOutputs {
  return {
    rust: renderRust(schema),
    typescript: renderTypeScript(schema),
    lean: renderLean(schema),
  };
}

async function runGenerator(arguments_: readonly string[]): Promise<void> {
  const checkOnly = decodeArguments(arguments_);
  const source: unknown = JSON.parse(await Deno.readTextFile(schemaPath));
  const outputs = generateQCore(decodeQCoreSchema(source));

  if (checkOnly) {
    await checkOutputs(outputs);
    return;
  }

  await Promise.all([
    Deno.writeTextFile(outputPaths.rust, outputs.rust),
    Deno.writeTextFile(outputPaths.typescript, outputs.typescript),
    Deno.writeTextFile(outputPaths.lean, outputs.lean),
  ]);
}

function decodeArguments(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--check") return true;
  throw new Error(
    `generate_qcore.ts accepts only --check, received ${arguments_.join(" ")}`,
  );
}

async function checkOutputs(outputs: QCoreOutputs): Promise<void> {
  for (
    const [target, expected] of [
      [outputPaths.rust, outputs.rust],
      [outputPaths.typescript, outputs.typescript],
      [outputPaths.lean, outputs.lean],
    ] as const
  ) {
    const current = await Deno.readTextFile(target);
    if (current !== expected) {
      throw new Error(
        `${target} is stale; run \`deno task generate:qcore\``,
      );
    }
  }
}

function decodeReference(
  source: unknown,
  index: number,
): ReferenceDefinition {
  const context = `QCore reference ${index}`;
  expectKeys(source, ["name", "representation"], context);
  const name = declarationName(source, context);
  const representation = stringField(source, "representation", context);
  if (representation !== "u32" && representation !== "string") {
    throw new Error(
      `${context} representation must be u32 or string, received ${representation}`,
    );
  }
  return { name, representation };
}

function decodeRecord(source: unknown, index: number): RecordDefinition {
  const context = `QCore record ${index}`;
  expectKeys(source, ["name", "fields"], context);
  const name = declarationName(source, context);
  return {
    name,
    fields: decodeFields(source, `${context} ${name}`),
  };
}

function decodeUnion(source: unknown, index: number): UnionDefinition {
  const context = `QCore union ${index}`;
  expectKeys(source, ["name", "tag_type", "variants"], context);
  const name = declarationName(source, context);
  const tagType = stringField(source, "tag_type", context);
  if (tagType !== "u8") {
    throw new Error(`${context} tag_type must be u8, received ${tagType}`);
  }
  const variants = arrayField(source, "variants", context).map(
    (entry, variantIndex) => decodeVariant(entry, name, variantIndex),
  );
  if (variants.length === 0) {
    throw new Error(`${context} must declare at least one variant`);
  }
  return { name, tagType, variants };
}

function decodeVariant(
  source: unknown,
  unionName: string,
  index: number,
): VariantDefinition {
  const context = `QCore union ${unionName} variant ${index}`;
  expectKeys(source, ["name", "tag", "fields"], context);
  const name = declarationName(source, context);
  const tag = integerField(source, "tag", context);
  if (tag < 0 || tag > 255) {
    throw new Error(`${context} tag must fit u8, received ${tag}`);
  }
  return {
    name,
    tag,
    fields: decodeFields(source, `${context} ${name}`),
  };
}

function decodeFields(
  source: unknown,
  context: string,
): readonly FieldDefinition[] {
  return arrayField(source, "fields", context).map((entry, index) => {
    const fieldContext = `${context} field ${index}`;
    expectKeys(entry, ["name", "type"], fieldContext);
    const name = stringField(entry, "name", fieldContext);
    if (!fieldNamePattern.test(name)) {
      throw new Error(
        `${fieldContext} name must be lower snake case, received ${name}`,
      );
    }
    return {
      name,
      type: stringField(entry, "type", fieldContext),
    };
  });
}

function declarationName(source: unknown, context: string): string {
  const name = stringField(source, "name", context);
  if (!declarationNamePattern.test(name)) {
    throw new Error(
      `${context} name must be a PascalCase identifier, received ${name}`,
    );
  }
  return name;
}

function validateDeclarations(schema: QCoreSchema): void {
  const knownTypes = new Set(primitiveTypes);
  for (
    const declaration of [
      ...schema.references,
      ...schema.unions,
      ...schema.records,
    ]
  ) {
    if (knownTypes.has(declaration.name)) {
      throw new Error(`duplicate QCore declaration ${declaration.name}`);
    }
    knownTypes.add(declaration.name);
  }

  for (const union of schema.unions) {
    validateUniqueNames(
      union.variants.map((variant) => variant.name),
      `QCore union ${union.name} variant`,
    );
    for (const [index, variant] of union.variants.entries()) {
      if (variant.tag !== index) {
        throw new Error(
          `QCore union ${union.name} tag ${variant.tag} must equal its dense position ${index}`,
        );
      }
      validateFields(
        variant.fields,
        knownTypes,
        `${union.name}.${variant.name}`,
      );
    }
  }

  for (const record of schema.records) {
    validateFields(record.fields, knownTypes, record.name);
  }
  validateLeanDeclarationOrder(schema);
}

function validateFields(
  fields: readonly FieldDefinition[],
  knownTypes: ReadonlySet<string>,
  context: string,
): void {
  validateUniqueNames(
    fields.map((field) => field.name),
    `QCore ${context} field`,
  );
  for (const field of fields) {
    const elementType = schemaElementType(field.type);
    if (!knownTypes.has(elementType)) {
      throw new Error(
        `QCore ${context}.${field.name} refers to unknown type ${elementType}`,
      );
    }
  }
}

function validateLeanDeclarationOrder(schema: QCoreSchema): void {
  const available = new Set([
    ...primitiveTypes,
    ...schema.references.map((reference) => reference.name),
  ]);
  for (const union of schema.unions) {
    validateAvailableTypes(union.name, union.variants, available);
    available.add(union.name);
  }
  for (const record of schema.records) {
    validateAvailableTypes(record.name, [record], available);
    available.add(record.name);
  }
}

function validateAvailableTypes(
  declarationName: string,
  fieldOwners: readonly { readonly fields: readonly FieldDefinition[] }[],
  available: ReadonlySet<string>,
): void {
  for (const fieldOwner of fieldOwners) {
    for (const field of fieldOwner.fields) {
      const elementType = schemaElementType(field.type);
      if (!available.has(elementType)) {
        throw new Error(
          `QCore type ${elementType} must be declared before ${declarationName}`,
        );
      }
    }
  }
}

function schemaElementType(type: string): string {
  const firstListSuffix = type.indexOf("[]");
  if (firstListSuffix < 0) return type;
  if (firstListSuffix !== type.length - 2 || firstListSuffix === 0) {
    throw new Error(`QCore field type ${type} has invalid list syntax`);
  }
  return type.slice(0, -2);
}

function validateUniqueNames(names: readonly string[], context: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`duplicate ${context} ${name}`);
    seen.add(name);
  }
}

function expectKeys(
  source: unknown,
  expectedKeys: readonly string[],
  context: string,
): void {
  if (!isObject(source)) throw new Error(`${context} must be an object`);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(source)) {
    if (!expected.has(key)) {
      throw new Error(`${context} has unknown field ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(source, key)) {
      throw new Error(`${context} is missing field ${key}`);
    }
  }
}

function stringField(source: unknown, key: string, context: string): string {
  const value = objectField(source, key, context);
  if (typeof value !== "string") {
    throw new Error(`${context}.${key} must be a string`);
  }
  return value;
}

function integerField(source: unknown, key: string, context: string): number {
  const value = objectField(source, key, context);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${context}.${key} must be a safe integer`);
  }
  return value;
}

function arrayField(
  source: unknown,
  key: string,
  context: string,
): readonly unknown[] {
  const value = objectField(source, key, context);
  if (!Array.isArray(value)) {
    throw new Error(`${context}.${key} must be an array`);
  }
  return value;
}

function objectField(source: unknown, key: string, context: string): unknown {
  if (!isObject(source)) throw new Error(`${context} must be an object`);
  return Reflect.get(source, key);
}

function isObject(source: unknown): source is object {
  return typeof source === "object" && source !== null &&
    !Array.isArray(source);
}

function renderRust(schema: QCoreSchema): string {
  const sections = [
    generatedHeader("//"),
    `pub const QCORE_SCHEMA_VERSION: u32 = ${schema.version};`,
    ...schema.references.map(renderRustReference),
    ...schema.unions.flatMap((union) => [
      renderRustTag(union),
      renderRustUnion(union),
    ]),
    ...schema.records.map(renderRustRecord),
  ];
  return `${sections.join("\n\n")}\n`;
}

function renderRustReference(reference: ReferenceDefinition): string {
  let derives = "Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd";
  if (reference.representation === "u32") {
    derives = "Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd";
  }
  return [
    `#[derive(${derives})]`,
    `pub struct ${reference.name}(pub ${rustType(reference.representation)});`,
  ].join("\n");
}

function renderRustTag(union: UnionDefinition): string {
  const variants = union.variants.map((variant) =>
    `    ${variant.name} = ${variant.tag},`
  );
  return [
    "#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]",
    `#[repr(${union.tagType})]`,
    `pub enum ${union.name}Tag {`,
    ...variants,
    "}",
  ].join("\n");
}

function renderRustUnion(union: UnionDefinition): string {
  const compactSingleFields = union.variants.every((variant) =>
    variant.fields.length < 2
  );
  const variants = union.variants.flatMap((variant) => {
    if (variant.fields.length === 0) return [`    ${variant.name},`];
    if (compactSingleFields && variant.fields.length === 1) {
      const field = variant.fields[0];
      return [
        `    ${variant.name} { ${field.name}: ${rustType(field.type)} },`,
      ];
    }
    return [
      `    ${variant.name} {`,
      ...variant.fields.map((field) =>
        `        ${field.name}: ${rustType(field.type)},`
      ),
      "    },",
    ];
  });
  const tagArms = union.variants.map((variant) => {
    let pattern = "";
    if (variant.fields.length > 0) pattern = " { .. }";
    return `            Self::${variant.name}${pattern} => ${union.name}Tag::${variant.name},`;
  });
  return [
    "#[derive(Clone, Debug, Eq, Hash, PartialEq)]",
    `pub enum ${union.name} {`,
    ...variants,
    "}",
    "",
    `impl ${union.name} {`,
    `    pub const fn tag(&self) -> ${union.name}Tag {`,
    "        match self {",
    ...tagArms,
    "        }",
    "    }",
    "}",
  ].join("\n");
}

function renderRustRecord(record: RecordDefinition): string {
  return [
    "#[derive(Clone, Debug, Eq, Hash, PartialEq)]",
    `pub struct ${record.name} {`,
    ...record.fields.map((field) =>
      `    pub ${field.name}: ${rustType(field.type)},`
    ),
    "}",
  ].join("\n");
}

function rustType(type: string): string {
  const elementType = schemaElementType(type);
  if (elementType !== type) return `Vec<${rustType(elementType)}>`;
  if (type === "string") return "String";
  return type;
}

function renderTypeScript(schema: QCoreSchema): string {
  const sections = [
    generatedHeader("//"),
    `export const qcoreSchemaVersion = ${schema.version};`,
    ...schema.references.map(renderTypeScriptReference),
    ...schema.unions.flatMap((union) => [
      renderTypeScriptTag(union),
      renderTypeScriptUnion(union),
    ]),
    ...schema.records.map(renderTypeScriptRecord),
  ];
  return `${sections.join("\n\n")}\n`;
}

function renderTypeScriptReference(
  reference: ReferenceDefinition,
): string {
  const fieldName = pascalToSnakeCase(reference.name);
  return [
    `export interface ${reference.name} {`,
    `  readonly ${fieldName}: ${typeScriptType(reference.representation)};`,
    "}",
  ].join("\n");
}

function renderTypeScriptTag(union: UnionDefinition): string {
  return [
    `export enum ${union.name}Tag {`,
    ...union.variants.map((variant) => `  ${variant.name} = ${variant.tag},`),
    "}",
  ].join("\n");
}

function renderTypeScriptUnion(union: UnionDefinition): string {
  const variants = union.variants.flatMap((variant, index) => {
    let closingBrace = "  }";
    if (index === union.variants.length - 1) closingBrace = "  };";
    return [
      "  | {",
      `    readonly tag: ${union.name}Tag.${variant.name};`,
      ...variant.fields.map((field) =>
        `    readonly ${field.name}: ${typeScriptType(field.type)};`
      ),
      closingBrace,
    ];
  });
  return [`export type ${union.name} =`, ...variants].join("\n");
}

function renderTypeScriptRecord(record: RecordDefinition): string {
  return [
    `export interface ${record.name} {`,
    ...record.fields.map((field) =>
      `  readonly ${field.name}: ${typeScriptType(field.type)};`
    ),
    "}",
  ].join("\n");
}

function typeScriptType(type: string): string {
  const elementType = schemaElementType(type);
  if (elementType !== type) {
    return `readonly ${typeScriptType(elementType)}[]`;
  }
  if (type === "u8" || type === "u32") return "number";
  if (type === "bool") return "boolean";
  if (type === "string") return "string";
  return type;
}

function renderLean(schema: QCoreSchema): string {
  const sections = [
    generatedHeader("--"),
    "namespace Blot.QCoreGenerated",
    `def schemaVersion : UInt32 := ${schema.version}`,
    ...schema.references.map(renderLeanReference),
    ...schema.unions.flatMap((union) => [
      renderLeanTag(union),
      renderLeanUnion(union),
    ]),
    ...schema.records.map(renderLeanRecord),
    "end Blot.QCoreGenerated",
  ];
  return `${sections.join("\n\n")}\n`;
}

function renderLeanReference(reference: ReferenceDefinition): string {
  return [
    `structure ${reference.name} where`,
    `  «value» : ${leanType(reference.representation)}`,
    "  deriving BEq, DecidableEq, Repr",
  ].join("\n");
}

function renderLeanTag(union: UnionDefinition): string {
  const constructors = union.variants.map((variant) => `  | ${variant.name}`);
  const codes = union.variants.map((variant) =>
    `  | .${variant.name} => ${variant.tag}`
  );
  return [
    `inductive ${union.name}Tag where`,
    ...constructors,
    "  deriving BEq, DecidableEq, Repr",
    "",
    `def ${union.name}Tag.code : ${union.name}Tag → UInt8`,
    ...codes,
  ].join("\n");
}

function renderLeanUnion(union: UnionDefinition): string {
  const constructors = union.variants.map((variant) => {
    const fields = variant.fields.map((field) =>
      ` (${leanIdentifier(field.name)} : ${leanType(field.type)})`
    ).join("");
    return `  | ${variant.name}${fields}`;
  });
  const tagArms = union.variants.map((variant) => {
    const fields = variant.fields.map(() => " _").join("");
    return `  | .${variant.name}${fields} => .${variant.name}`;
  });
  return [
    `inductive ${union.name} where`,
    ...constructors,
    "  deriving BEq, DecidableEq, Repr",
    "",
    `def ${union.name}.tag : ${union.name} → ${union.name}Tag`,
    ...tagArms,
  ].join("\n");
}

function renderLeanRecord(record: RecordDefinition): string {
  return [
    `structure ${record.name} where`,
    ...record.fields.map((field) =>
      `  ${leanIdentifier(field.name)} : ${leanType(field.type)}`
    ),
    "  deriving BEq, DecidableEq, Repr",
  ].join("\n");
}

function leanType(type: string): string {
  const elementType = schemaElementType(type);
  if (elementType !== type) return `List ${leanType(elementType)}`;
  if (type === "u8") return "UInt8";
  if (type === "u32") return "UInt32";
  if (type === "bool") return "Bool";
  if (type === "string") return "String";
  return type;
}

function leanIdentifier(name: string): string {
  return `«${name}»`;
}

function pascalToSnakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function generatedHeader(commentPrefix: string): string {
  return `${commentPrefix} Generated from qcore/schema.json by scripts/generate_qcore.ts. Do not edit.`;
}

if (import.meta.main) await runGenerator(Deno.args);
