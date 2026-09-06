import type { BlotAbiType } from "./abi.ts";

type RecordType = Extract<BlotAbiType, { kind: "record" }>;
type VariantType = Extract<BlotAbiType, { kind: "variant" }>;

export interface AbiMemoryLayout {
  readonly alignment: number;
  readonly size: number;
}

export interface AbiRecordLayout extends AbiMemoryLayout {
  readonly fields: readonly {
    readonly name: string;
    readonly type: BlotAbiType;
    readonly offset: number;
  }[];
}

export interface AbiVariantLayout extends AbiMemoryLayout {
  readonly discriminantSize: number;
  readonly payloadOffset: number;
  readonly cases: VariantType["cases"];
}

/** Layouts are keyed by immutable, parsed ABI descriptors, never guest memory. */
export class AbiMemoryLayouts {
  readonly #layouts = new WeakMap<BlotAbiType, AbiMemoryLayout>();

  get(type: RecordType): AbiRecordLayout;
  get(type: VariantType): AbiVariantLayout;
  get(type: BlotAbiType): AbiMemoryLayout;
  get(type: BlotAbiType): AbiMemoryLayout {
    const cached = this.#layouts.get(type);
    if (cached !== undefined) return cached;
    const layout = this.#compute(type);
    this.#layouts.set(type, layout);
    return layout;
  }

  #compute(type: BlotAbiType): AbiMemoryLayout {
    if (type.kind === "unit") return { alignment: 1, size: 0 };
    if (type.kind === "boolean") return { alignment: 1, size: 1 };
    if (type.kind === "float-32") return { alignment: 4, size: 4 };
    if (type.kind === "signed-integer-64" || type.kind === "float-64") {
      return { alignment: 8, size: 8 };
    }
    if (type.kind === "text" || type.kind === "array") {
      return { alignment: 4, size: 8 };
    }
    if (type.kind === "sealed") return this.get(type.inner);
    if (type.kind === "record") {
      let offset = 0;
      let alignment = 1;
      const fields = [...type.fields].sort(byName).map((field) => {
        const { name, type: fieldType } = field;
        const layout = this.get(fieldType);
        offset = alignTo(offset, layout.alignment);
        const result = { name, type: fieldType, offset };
        offset += layout.size;
        alignment = Math.max(alignment, layout.alignment);
        return result;
      });
      const layout: AbiRecordLayout = {
        fields,
        alignment,
        size: alignTo(offset, alignment),
      };
      return layout;
    }
    let discriminantSize = 4;
    if (type.cases.length <= 65_536) discriminantSize = 2;
    if (type.cases.length <= 256) discriminantSize = 1;
    let payloadAlignment = 1;
    let payloadSize = 0;
    const cases = [...type.cases].sort(byName);
    for (const case_ of cases) {
      if (case_.payload === undefined) continue;
      const layout = this.get(case_.payload);
      payloadAlignment = Math.max(payloadAlignment, layout.alignment);
      payloadSize = Math.max(payloadSize, layout.size);
    }
    const alignment = Math.max(discriminantSize, payloadAlignment);
    const payloadOffset = alignTo(discriminantSize, payloadAlignment);
    const layout: AbiVariantLayout = {
      cases,
      discriminantSize,
      payloadOffset,
      alignment,
      size: alignTo(payloadOffset + payloadSize, alignment),
    };
    return layout;
  }
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function byName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}
