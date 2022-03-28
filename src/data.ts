import * as aq from 'arquero';
import * as fflate from 'fflate';
//import pq from 'parquet-wasm';

/** Types */
import Table from 'arquero/dist/types/table/table';

const from = function (array: Array<Object>): Table {
  return aq.from(array);
};

const fromURL = async function (url: string): Promise<Table> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(response.statusText);
  }
  return fromArrayBuffer(await response.arrayBuffer());
};

const fromJSON = function (
  json_or_str: Array<Object> | Object | string
): Table {
  const json =
    typeof json_or_str === 'string' ? JSON.parse(json_or_str) : json_or_str;
  const aq_loader = Array.isArray(json) ? aq.from : aq.fromJSON;
  return aq_loader(json);
};

const fromArrow = function (arrow: Array<Object>): Table {
  return aq.fromArrow(arrow);
};

const fromArrayBuffer = function (buf: ArrayBuffer): Table {
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

export { from, fromArrayBuffer, fromArrow, fromJSON, fromURL };
