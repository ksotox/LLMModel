// A tiny ONNX model, written byte by byte (no tools needed): c = a + b on two float vectors of
// length `n`. Used to check that the AI runtime loads and runs in the browser.

const varint = (n) => {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const field = (no, type) => varint((no << 3) | type);
const bytes = (no, data) => [...field(no, 2), ...varint(data.length), ...data];
const str = (no, s) => bytes(no, [...Buffer.from(s, 'utf8')]);
const int = (no, v) => [...field(no, 0), ...varint(v)];

// ValueInfoProto { name, type: TypeProto { tensor_type: { elem_type: FLOAT(1), shape: { dim: [n] } } } }
const valueInfo = (name, n) => [
  ...str(1, name),
  ...bytes(2, bytes(1, [...int(1, 1), ...bytes(2, bytes(1, int(1, n)))])),
];

export function addModel(n = 3) {
  const node = [...str(1, 'a'), ...str(1, 'b'), ...str(2, 'c'), ...str(4, 'Add')];
  const graph = [...bytes(1, node), ...str(2, 'add'), ...bytes(11, valueInfo('a', n)), ...bytes(11, valueInfo('b', n)), ...bytes(12, valueInfo('c', n))];
  const model = [...int(1, 8), ...bytes(7, graph), ...bytes(8, int(2, 13))]; // ir_version 8, graph, opset 13
  return Uint8Array.from(model);
}
