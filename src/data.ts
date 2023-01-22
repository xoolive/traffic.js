import * as aq from 'arquero';
import * as fflate from 'fflate';

//import pq from 'parquet-wasm';

const from = function (array: Array<Object>) {
  return aq.from(array);
};

const fromURL = async function (url: string) {
  return await aq.load(url, { as: 'arrayBuffer', using: fromArrayBuffer });
};

const fromJSON = function (json_or_str: Array<Object> | Object | string) {
  const json =
    typeof json_or_str === 'string' ? JSON.parse(json_or_str) : json_or_str;
  const aq_loader = Array.isArray(json) ? aq.from : aq.fromJSON;
  return aq_loader(json);
};

const fromArrow = function (arrow: Array<Object>) {
  return aq.fromArrow(arrow);
};

const fromArrayBuffer = function (buf: ArrayBuffer) {
  const array = new Uint8Array(buf);
  let data;
  // -- GZip file header --
  if (array[0] === 0x1f && array[1] === 0x8b) {
    data = fflate.strFromU8(fflate.decompressSync(array));
    return fromJSON(data);
  } /*else if (
    // -- Parquet file header --
    Array(...array.slice(0, 4))
      .map((elt) => String.fromCharCode(elt))
      .join('') === 'PAR1'
  ) {
    const parquet = pq.readParquet(array);
    return aq.fromArrow(parquet);
  }*/ else {
    /** JSON text */
    const decoder = new TextDecoder('utf-8');
    data = decoder.decode(new Uint8Array(buf));
    return fromJSON(data);
  }
};

// Mixins, based on
// https://www.bryntum.com/blog/the-mixin-pattern-in-typescript-all-you-need-to-know/

// To get started, we need a type which we'll use to extend
// other classes from. The main responsibility is to declare
// that the type being passed in is a class.

export type AnyFunction<A = any> = (...input: any[]) => A;
export type AnyConstructor<A = object> = new (...input: any[]) => A;
export type Mixin<T extends AnyFunction> = InstanceType<ReturnType<T>>;

// This mixin adds all the methods to construct a new Flight, Traffic, etc.

export function TableMixin<T extends AnyConstructor>(base: T) {
  return class TableWrapper extends base {
    static from(array: Array<Object>) {
      return new TableWrapper(from(array), '%Q');
    }
    static fromArrayBuffer(buf: ArrayBuffer) {
      return new TableWrapper(fromArrayBuffer(buf), '%Q');
    }
    static fromArrow(arrow: Array<Object>) {
      return new TableWrapper(fromArrow(arrow), '%Q');
    }
    static fromJSON(json_or_str: Array<Object> | Object | string) {
      return new TableWrapper(fromJSON(json_or_str), '%Q');
    }
    static async fromURL(url: string) {
      return new TableWrapper(await fromURL(url), '%Q');
    }
  };
}

export type TableMixin = Mixin<typeof TableMixin>;
